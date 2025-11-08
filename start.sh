#!/bin/bash

echo "============================================="
echo "   Local File Share - Linux/Mac Launcher"
echo "============================================="
echo

echo "Starting the file sharing server..."
echo

# Check if Python is installed
if ! command -v python3 &> /dev/null; then
    echo "ERROR: Python 3 is not installed"
    echo "Please install Python 3.6+ using your package manager"
    echo
    echo "Ubuntu/Debian: sudo apt install python3"
    echo "CentOS/RHEL:   sudo yum install python3"
    echo "macOS:         brew install python3"
    echo
    exit 1
fi

# Make the script executable
chmod +x "$0"

# Start the server
echo "Python 3 found. Starting server..."
echo
python3 server.py