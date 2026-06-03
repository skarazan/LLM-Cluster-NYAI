param(
  [string]$ModelFile = 'Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf',
  [string]$Repo = 'bartowski/Qwen2.5-Coder-7B-Instruct-GGUF'
)

$modelsDir = Join-Path $env:USERPROFILE 'llm-cluster\models'
New-Item -ItemType Directory -Path $modelsDir -Force | Out-Null
$dest = Join-Path $modelsDir $ModelFile
$url = "https://huggingface.co/$Repo/resolve/main/$ModelFile"

Write-Host "Downloading $ModelFile to $dest ..."
try {
  if ($env:HF_TOKEN) {
    $headers = @{ Authorization = "Bearer $env:HF_TOKEN" }
    Invoke-WebRequest -Uri $url -Headers $headers -OutFile $dest -UseBasicParsing -ErrorAction Stop
  } else {
    Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing -ErrorAction Stop
  }
  Write-Host "Download complete."
} catch {
  Write-Host "Download failed: $($_.Exception.Message)"
  exit 1
}

# Find llama-server binary or command
$binCandidates = @(
  Join-Path $env:USERPROFILE 'llm-cluster\bin\llama-server.exe',
  Join-Path $env:USERPROFILE 'llm-cluster\bin\llama-server',
  'llama-server'
)
$bin = $null
foreach ($b in $binCandidates) {
  if (Test-Path $b) { $bin = $b; break }
  try { $cmd = Get-Command $b -ErrorAction Stop; if ($cmd) { $bin = $cmd.Path; break } } catch {}
}
if (-not $bin) {
  Write-Host "Could not find 'llama-server' binary. Please install it or use the Worker App. Exiting."
  exit 2
}

Write-Host "Starting llama-server: $bin -m $dest ..."
Start-Process -FilePath $bin -ArgumentList "-m `"$dest`" -ngl 999 --host 0.0.0.0 --port 8080" -NoNewWindow -WindowStyle Hidden

# Wait for engine
Write-Host "Waiting for engine to respond on http://localhost:8080 ..."
$ok = $false
for ($i=0;$i -lt 30;$i++) {
  Start-Sleep -Seconds 2
  try {
    $r = Invoke-RestMethod -Uri 'http://localhost:8080/v1/models' -Method Get -ErrorAction Stop
    Write-Host "Engine responded:"
    $r | ConvertTo-Json -Depth 3 | Write-Host
    $ok = $true; break
  } catch {
    Write-Host -NoNewline "."
  }
}
if (-not $ok) { Write-Host "Engine did not respond on http://localhost:8080; check logs. Exiting."; exit 3 }

# Start worker (detached)
$workerDir = Join-Path $PSScriptRoot '..\worker'
Write-Host "Starting worker in $workerDir ..."
Start-Process -FilePath "node" -ArgumentList "index.js http://localhost:3000" -WorkingDirectory $workerDir -NoNewWindow

Write-Host "Done. llama-server and worker started (detached)."