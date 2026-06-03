Param()
Write-Host "This script attempts to clone and build llama.cpp as a baseline for a local 'llama-server'."
Write-Host "You may need to adapt it for Windows (Visual Studio / CMake / MSYS)."

$root = Split-Path -Parent $MyInvocation.MyCommand.Definition
$tp = Join-Path $root '..\third_party\llama.cpp' | Resolve-Path -ErrorAction SilentlyContinue
if (-not $tp) {
  git clone https://github.com/ggerganov/llama.cpp (Join-Path $root '..\third_party\llama.cpp')
} else {
  Write-Host "third_party\llama.cpp already exists"
}

Write-Host "On Windows you typically need Visual Studio + CMake. Open the repo in a developer prompt and run the recommended build steps from llama.cpp README."
Write-Host "After you build or provide a compatible server binary, place it in .\bin\llama-server or set LLM_ENGINE_BIN to the executable path."
Write-Host "To auto-start the engine, add an 'engineAutoStartCmd' to ~/.llm-cluster-worker.json or set LLM_ENGINE_AUTO_START_CMD env var."
