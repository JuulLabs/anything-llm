import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildMachineArgs, gpuDeviceArgs, isoDeviceArgs, buildNetdevString, workspaceFsdevArgs, isValidRam, buildQemuArgs } from './vm.js';

// These tests lock in the Windows x64 (WHPX) behavior and, just as importantly,
// prove the macOS/Linux paths are unchanged (no VGA, no q35-only ide-cd bus).

test('buildMachineArgs: Windows x86_64 uses WHPX with a Haswell CPU, not host', () => {
  // -cpu host exposes APX/MPX on recent AMD CPUs, which WHPX rejects with
  // "Unexpected VP exit code 4".
  assert.deepEqual(
    buildMachineArgs('win32', 'x86_64'),
    ['-machine', 'q35', '-accel', 'whpx', '-cpu', 'Haswell'],
  );
});

test('buildMachineArgs: Windows aarch64 keeps host passthrough', () => {
  assert.deepEqual(
    buildMachineArgs('win32', 'aarch64'),
    ['-machine', 'virt,highmem=on', '-accel', 'whpx', '-cpu', 'host'],
  );
});

test('buildMachineArgs: macOS uses HVF with host for both guest arches', () => {
  assert.deepEqual(
    buildMachineArgs('darwin', 'aarch64'),
    ['-machine', 'virt,highmem=on', '-accel', 'hvf', '-cpu', 'host'],
  );
  assert.deepEqual(
    buildMachineArgs('darwin', 'x86_64'),
    ['-machine', 'q35', '-accel', 'hvf', '-cpu', 'host'],
  );
});

test('buildMachineArgs: Linux uses KVM with host', () => {
  assert.deepEqual(
    buildMachineArgs('linux', 'x86_64'),
    ['-machine', 'q35', '-accel', 'kvm', '-cpu', 'host'],
  );
});

test('gpuDeviceArgs: Windows uses standard VGA, other platforms use virtio-gpu', () => {
  assert.deepEqual(gpuDeviceArgs('win32'), ['-device', 'VGA']);
  assert.deepEqual(gpuDeviceArgs('darwin'), ['-device', 'virtio-gpu-pci']);
  assert.deepEqual(gpuDeviceArgs('linux'), ['-device', 'virtio-gpu-pci']);
});

test('isoDeviceArgs: attaches a bootable USB CD-ROM only on Windows', () => {
  const win = isoDeviceArgs('/tmp/debian.iso', 'win32');
  assert.ok(win.includes('usb-storage,drive=install-cdrom'));
  assert.ok(win.some((s) => s.includes('media=cdrom')));
  assert.ok(win.some((s) => s.includes('/tmp/debian.iso')));
});

test('isoDeviceArgs: no CD-ROM on macOS/Linux', () => {
  assert.deepEqual(isoDeviceArgs('/tmp/debian.iso', 'darwin'), []);
  assert.deepEqual(isoDeviceArgs('/tmp/debian.iso', 'linux'), []);
});

test('isoDeviceArgs: no CD-ROM when no ISO is provided', () => {
  assert.deepEqual(isoDeviceArgs(undefined, 'win32'), []);
});

test('buildNetdevString: hostfwd entries are bound to loopback', () => {
  const s = buildNetdevString({ sshPort: 2222, appPort: 9800 });
  assert.ok(s.startsWith('user,id=net0,hostfwd=tcp:127.0.0.1:2222-:22,hostfwd=tcp:127.0.0.1:9800-:18790'));
});

test('buildNetdevString: no app forward without appPort', () => {
  const s = buildNetdevString({ sshPort: 2222 });
  assert.ok(!s.includes('18790'));
});

test('buildNetdevString: default is restricted with proxy/LLM pinholes', () => {
  assert.equal(
    buildNetdevString({ sshPort: 2222, appPort: 9800, llmPort: 1234 }),
    'user,id=net0,hostfwd=tcp:127.0.0.1:2222-:22,hostfwd=tcp:127.0.0.1:9800-:18790'
    + ',restrict=on'
    + ',guestfwd=tcp:10.0.2.100:3128-cmd:nc 127.0.0.1 3128'
    + ',guestfwd=tcp:10.0.2.101:1234-cmd:nc 127.0.0.1 1234',
  );
});

test('buildNetdevString: without llmPort only the proxy pinhole opens', () => {
  const s = buildNetdevString({ sshPort: 2222 });
  assert.ok(s.includes('restrict=on'));
  assert.ok(s.includes('guestfwd=tcp:10.0.2.100:3128-cmd:nc 127.0.0.1 3128'));
  assert.ok(!s.includes('10.0.2.101'));
});

test('buildNetdevString: custom proxy port is honored', () => {
  const s = buildNetdevString({ sshPort: 2222, proxyPort: 8888 });
  assert.ok(s.includes('guestfwd=tcp:10.0.2.100:8888-cmd:nc 127.0.0.1 8888'));
});

test('buildNetdevString: unrestricted (base image) has no restrict or pinholes', () => {
  const s = buildNetdevString({ sshPort: 2222, appPort: 9800, unrestricted: true });
  assert.equal(s, 'user,id=net0,hostfwd=tcp:127.0.0.1:2222-:22,hostfwd=tcp:127.0.0.1:9800-:18790');
  assert.ok(!s.includes('restrict'));
  assert.ok(!s.includes('guestfwd'));
});

test('workspaceFsdevArgs: builds the 9p workspace share', () => {
  assert.deepEqual(workspaceFsdevArgs('/tmp/agents/foo/shared'), [
    '-fsdev', 'local,id=workspace,path=/tmp/agents/foo/shared,security_model=mapped-xattr',
    '-device', 'virtio-9p-pci,fsdev=workspace,mount_tag=open-computer_shared',
  ]);
});

test('workspaceFsdevArgs: empty when no workspace path', () => {
  assert.deepEqual(workspaceFsdevArgs(undefined), []);
});

test('isValidRam: accepts N followed by G/M, rejects everything else', () => {
  for (const ok of ['8G', '12G', '512M', '4096m', '2g']) assert.ok(isValidRam(ok));
  for (const bad of ['8', 'G8', '8GB', '8 G', '1.5G', '', '8T']) assert.ok(!isValidRam(bad));
});

function ramFromArgs(ram?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-vmtest-'));
  const efi = path.join(dir, 'efi-vars.fd');
  fs.writeFileSync(efi, '');
  try {
    const args = buildQemuArgs({
      disk: path.join(dir, 'disk.qcow2'),
      efi,
      sshPort: 2222,
      pidFile: path.join(dir, 'qemu.pid'),
      monitorSock: path.join(dir, 'monitor.sock'),
      ram,
    });
    return args[args.indexOf('-m') + 1];
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('buildQemuArgs: -m defaults to 8G', () => {
  assert.equal(ramFromArgs(), '8G');
});

test('buildQemuArgs: -m honors the ram override', () => {
  assert.equal(ramFromArgs('12G'), '12G');
});
