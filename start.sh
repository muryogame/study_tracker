#!/bin/bash
cd "$(dirname "$0")"

if ! python3 -c "import fastapi" 2>/dev/null; then
  echo "Installing dependencies..."
  pip3 install -r requirements.txt -q
fi

echo "Starting 学録 at http://localhost:8765"
uvicorn main:app --host 0.0.0.0 --port 8765 --reload
