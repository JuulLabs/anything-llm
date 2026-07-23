import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import { BASE_DISK, VM_USER, resolveEfiCode } from '../config.js';
import {
  agentDir, agentExists, agentEnvPath,
  readAgentJson, writeAgentJson, nextIndex, listAgents,
  pidfilePath, monitorSockPath, efiVarsPath,
} from '../registry.js';
import { isRunning, readPid, killPid, qemuImgCreate, removeMonitorSock, isValidRam } from '../vm.js';
import { isJsonMode, jsonOk, jsonErr, info } from '../output.js';
import { execUpCommand, killAgentRelay, killAgentMcpRelay } from './control.js';

export function registerAgentCommands(program: Command): void {
  program
    .command('create <name> [flags...]')
    .description('Create and start an agent (--no-start to skip boot)')
    .option('--no-start', 'Create without starting')
    .option('--dev', 'Mount services/ via 9p (dev mode)')
    .option('--gui', 'Show QEMU window')
    .option('--llm-port <port>', "Host LLM port for the 10.0.2.101 pinhole (default: the agent's persisted relay_port)")
    .option('--mcp', 'Opt this agent into MCP forwarding (allocates and persists mcp_port)')
    .option('--mcp-port <port>', "Host MCP port for the 10.0.2.102 pinhole (default: the agent's persisted mcp_port, if --mcp was given)")
    .option('--ram <size>', 'VM memory, e.g. 12G (default 8G; persisted in agent.json)')
    .action((name: string, _flags: string[], opts: { start: boolean; dev?: boolean; gui?: boolean; llmPort?: string; mcp?: boolean; mcpPort?: string; ram?: string }) => {
      if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
        jsonErr('Invalid name. Use alphanumeric, dash, underscore.');
      }
      if (opts.ram !== undefined && !isValidRam(opts.ram)) {
        jsonErr(`Invalid --ram value '${opts.ram}'. Use a number followed by G or M, e.g. 12G or 4096M.`);
      }
      if (agentExists(name)) jsonErr(`Agent '${name}' already exists.`);
      if (!fs.existsSync(BASE_DISK)) {
        jsonErr("No base image found. Run 'open-computer base install' first.");
      }

      const dir = agentDir(name);
      const index = nextIndex();
      fs.mkdirSync(path.join(dir, 'shared'), { recursive: true });

      // Create COW overlay
      qemuImgCreate(`${dir}/disk.qcow2`, BASE_DISK, '40G');

      // Copy EFI vars
      const efiDest = efiVarsPath(name);
      const baseEfi = path.join(path.dirname(BASE_DISK), 'efi-vars.fd');
      if (fs.existsSync(baseEfi)) {
        fs.copyFileSync(baseEfi, efiDest);
      } else {
        fs.copyFileSync(resolveEfiCode(), efiDest);
      }

      const agent = writeAgentJson(name, index, { ram: opts.ram, mcp: opts.mcp });
      const { ssh_port, vnc_port, app_port, relay_port, mcp_port } = agent;

      if (!opts.start) {
        if (isJsonMode()) {
          jsonOk({
            name, index, ssh_port, vnc_port, app_port, relay_port,
            ...(mcp_port !== undefined ? { mcp_port } : {}),
            desktop_url: `http://localhost:${app_port}`, started: false,
          });
        } else {
          info(`Created agent '${name}':`);
          info(`  SSH:      ssh -p ${ssh_port} ${VM_USER}@localhost`);
          info(`  VNC:      open vnc://localhost:${vnc_port}`);
          info(`  Desktop:  http://localhost:${app_port}`);
          info('');
          info(`Start with: open-computer up ${name}`);
        }
        return;
      }

      const started = execUpCommand(name, {
        dev: opts.dev ?? false,
        gui: opts.gui ?? false,
        llmPort: opts.llmPort !== undefined ? parseInt(opts.llmPort, 10) : undefined,
        mcpPort: opts.mcpPort !== undefined ? parseInt(opts.mcpPort, 10) : undefined,
        ram: opts.ram,
      });

      if (isJsonMode()) {
        jsonOk({
          name, index, ssh_port, vnc_port, app_port, relay_port,
          ...(mcp_port !== undefined ? { mcp_port } : {}),
          desktop_url: `http://localhost:${app_port}`, started,
        });
      } else {
        info(`Created agent '${name}':`);
        info(`  SSH:      ssh -p ${ssh_port} ${VM_USER}@localhost`);
        info(`  VNC:      open vnc://localhost:${vnc_port}`);
        info(`  Desktop:  http://localhost:${app_port}`);
      }
    });

  program
    .command('destroy <name>')
    .description('Delete an agent and its disk')
    .action((name: string) => {
      if (!agentExists(name)) jsonErr(`Agent '${name}' not found.`);

      const pf = pidfilePath(name);
      if (isRunning(pf)) {
        if (!isJsonMode()) info(`Agent '${name}' is running — killing it first...`);
        killPid(pf);
        removeMonitorSock(monitorSockPath(name));
      }
      killAgentRelay(name);
      killAgentMcpRelay(name);

      fs.rmSync(agentDir(name), { recursive: true, force: true });

      if (isJsonMode()) {
        jsonOk({ name });
      } else {
        info(`Destroyed agent '${name}'.`);
      }
    });

  program
    .command('list')
    .description('List all agents and their status')
    .action(() => {
      const names = listAgents();

      if (isJsonMode()) {
        const agents = names.map((name) => {
          const data = readAgentJson(name);
          const pf = pidfilePath(name);
          const running = isRunning(pf);
          const pid = running ? readPid(pf) : undefined;
          return {
            name: data.name,
            status: running ? 'running' : 'stopped',
            ssh_port: data.ssh_port,
            vnc_port: data.vnc_port,
            app_port: data.app_port,
            relay_port: data.relay_port,
            ...(data.mcp_port !== undefined ? { mcp_port: data.mcp_port } : {}),
            desktop_url: `http://localhost:${data.app_port}`,
            created: data.created,
            ...(pid !== null && pid !== undefined ? { pid } : {}),
          };
        });
        jsonOk({ agents });
        return;
      }

      if (names.length === 0) {
        info('No agents yet. Create one with: open-computer create <name>');
        return;
      }

      const nameW = 16, statusW = 8, sshW = 10, appW = 10, desktopW = 28;
      const header = [
        'NAME'.padEnd(nameW), 'STATUS'.padEnd(statusW),
        'SSH'.padEnd(sshW), 'APP'.padEnd(appW), 'DESKTOP'.padEnd(desktopW), 'CREATED',
      ].join(' ');
      const divider = [
        '----'.padEnd(nameW), '------'.padEnd(statusW),
        '---'.padEnd(sshW), '---'.padEnd(appW), '-------'.padEnd(desktopW), '-------',
      ].join(' ');
      console.log(header);
      console.log(divider);

      for (const name of names) {
        const data = readAgentJson(name);
        const pf = pidfilePath(name);
        const status = isRunning(pf) ? 'running' : 'stopped';
        const created = data.created.split('T')[0];
        console.log([
          data.name.padEnd(nameW),
          status.padEnd(statusW),
          `:${data.ssh_port}`.padEnd(sshW),
          `:${data.app_port}`.padEnd(appW),
          `http://localhost:${data.app_port}`.padEnd(desktopW),
          created,
        ].join(' '));
      }
    });
}
