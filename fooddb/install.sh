#!/bin/sh
# Installs the food barcode database server on Debian/Ubuntu (a small VM or LXC container is ideal).
# Needs Python 3.9+ with SQLite FTS5 (standard on Debian 12 / Ubuntu 22.04+), about 2 GB RAM for the
# weekly rebuild, and about 10 GB of free disk. Run as root from this folder:  sh install.sh
set -e
id fooddb >/dev/null 2>&1 || useradd --system --home /opt/fooddb --shell /usr/sbin/nologin fooddb
mkdir -p /opt/fooddb/work
cp update.py server.py /opt/fooddb/
chown -R fooddb:fooddb /opt/fooddb
cp fooddb-api.service fooddb-update.service fooddb-update.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now fooddb-api.service fooddb-update.timer
echo "Building the database for the first time. This downloads about 3 GB and takes 30-60 minutes..."
systemctl start fooddb-update.service
echo "Done. Check it with:  curl http://localhost:8080/health"
