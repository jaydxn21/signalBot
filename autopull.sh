#!/bin/bash
cd /home/atomicprod/signalBot
git pull origin main >> /home/atomicprod/signalBot/autopull.log 2>&1
pm2 restart signalbot >> /home/atomicprod/signalBot/autopull.log 2>&1
