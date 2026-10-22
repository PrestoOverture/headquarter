#!/bin/bash
# Frees runner disk for task images of up to ~30 GB plus a copy of /testbed (the first
# full run lost 8 writer jobs and 2 grade jobs to "no space left on device" with 44 GB
# free). Runs before setup-bun: it removes the whole tool cache.
set -u
sudo swapoff -a
sudo rm -f /swapfile /mnt/swapfile
sudo rm -rf /usr/share/dotnet /usr/local/lib/android /opt/ghc /opt/hostedtoolcache /usr/local/share/boost \
  /usr/local/share/powershell /usr/local/share/chromium /usr/share/swift /usr/local/.ghcup /opt/az /opt/microsoft \
  /opt/google /usr/lib/jvm /usr/share/miniconda /usr/local/julia* /usr/lib/google-cloud-sdk /opt/pipx \
  /usr/local/share/vcpkg /usr/share/az_* /home/runner/.rustup /home/runner/.cargo /usr/local/aws-cli
sudo apt-get clean
docker system prune -af >/dev/null
# Docker's storage goes on the bigger of / and /mnt, when the runner has a /mnt.
if mountpoint -q /mnt && [ "$(df --output=avail /mnt | tail -1)" -gt "$(df --output=avail / | tail -1)" ]; then
  sudo systemctl stop docker docker.socket
  echo '{"data-root": "/mnt/docker"}' | sudo tee /etc/docker/daemon.json >/dev/null
  sudo systemctl start docker
fi
df -h / /mnt 2>/dev/null || df -h /
