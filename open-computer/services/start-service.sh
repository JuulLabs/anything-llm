#!/bin/bash
# Override stale PORT=8080 from pre-existing systemd units on base images
# provisioned before the interface service moved to 18790.
export PORT=18790
if [ -f /opt/open-computer/interface-service/index.js ]; then
    exec nodemon --watch /opt/open-computer --ext js,json,ts --signal SIGTERM --legacy-watch --polling-interval 2000 /opt/open-computer/interface-service/index.js
else
    exec node /opt/open-computer/interface-service.cjs
fi
