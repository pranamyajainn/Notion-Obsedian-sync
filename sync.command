#!/bin/bash
cd "$(dirname "$0")"
node sync.js
echo ""
read -p "Press enter to close..."
