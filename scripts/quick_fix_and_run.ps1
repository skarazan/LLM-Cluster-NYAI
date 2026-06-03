# quick_fix_and_run.ps1
# Stops node, deletes locked GGUF, and starts the installer script detached
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Remove-Item -Path "$env:USERPROFILE\llm-cluster\models\Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf" -Force -ErrorAction SilentlyContinue
Start-Process -FilePath 'powershell' -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','C:\Users\skill\OneDrive\Documents\LLM-Cluster-NYAI\scripts\install_and_start_model.ps1' -WindowStyle Hidden
Write-Host 'Quick fix started: installer launched (detached).'
