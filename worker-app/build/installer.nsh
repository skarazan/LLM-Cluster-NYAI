; Kill all app processes before install or uninstall so Windows
; doesn't complain about files being in use.

!macro customInstall
  nsExec::ExecToLog 'taskkill /F /IM "LLM Cluster Worker.exe" /T'
  nsExec::ExecToLog 'taskkill /F /IM "llama-server.exe" /T'
!macroend

!macro customUnInstall
  nsExec::ExecToLog 'taskkill /F /IM "LLM Cluster Worker.exe" /T'
  nsExec::ExecToLog 'taskkill /F /IM "llama-server.exe" /T'
!macroend
