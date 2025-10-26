#!/bin/bash
# Filter workflow logs to show only soundboard sync info

# Run this from the terminal after running your workflow
# Usage: ./filter_logs.sh

# If you're running the workflow and want to capture output:
# npm start 2>&1 | tee full_log.txt

# Then run this script to filter it:
if [ -f "full_log.txt" ]; then
    echo "=== SOUNDBOARD SYNC SECTION ==="
    grep -A 20 "SOUNDBOARD SYNC" full_log.txt | grep -v "emission\|progress\|%"

    echo ""
    echo "=== DRIFT CALCULATIONS ==="
    grep "Drift:" full_log.txt

    echo ""
    echo "=== SPEED FACTORS ==="
    grep "speed=" full_log.txt

    echo ""
    echo "=== SKIPPING MESSAGES ==="
    grep -i "skip\|already have" full_log.txt
else
    echo "No full_log.txt found. Run your workflow like this first:"
    echo "npm start 2>&1 | tee full_log.txt"
fi
