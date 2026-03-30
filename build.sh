#!/bin/bash
set -e

echo "Building Fhenix Markets..."
echo "Current directory: $(pwd)"

# Navigate to frontend directory
cd frontend

echo "Installing dependencies..."
npm install

echo "Building application..."
npm run build

echo "Build complete!"
