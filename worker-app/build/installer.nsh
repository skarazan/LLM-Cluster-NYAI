; Kill all app processes before install or uninstall so Windows
; doesn't complain about files being in use.
; Uses multiple approaches for reliability.

!macro customInstall
  ; Kill main app + child processes
  nsExec::ExecToLog 'taskkill /F /IM "LLM Cluster Worker.exe" /T'
  nsExec::ExecToLog 'taskkill /F /IM "llama-server.exe" /T'
  nsExec::ExecToLog 'taskkill /F /IM "node.exe" /T'
  ; Wait for Windows to release file locks
  Sleep 2000
  ; Fallback: wmic for any stragglers matching our install path
  nsExec::ExecToLog 'wmic process where "ExecutablePath like ''%LLM Cluster Worker%''" call terminate'
  Sleep 1000
!macroend

!macro customUnInstall
  nsExec::ExecToLog 'taskkill /F /IM "LLM Cluster Worker.exe" /T'
  nsExec::ExecToLog 'taskkill /F /IM "llama-server.exe" /T'
  nsExec::ExecToLog 'taskkill /F /IM "node.exe" /T'
  Sleep 2000
  nsExec::ExecToLog 'wmic process where "ExecutablePath like ''%LLM Cluster Worker%''" call terminate'
  Sleep 1000
!macroend
