; electron-builder NSIS hooks. The backend runs as "opentrench.exe" too (Electron as node),
; and an orphaned one has no window for the stock "close the app" step to close, so the
; installer used to stop with "opentrench cannot be closed". Kill every instance first.
!macro customInit
  nsExec::ExecToLog 'taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}"'
  Sleep 500
!macroend

!macro customUnInit
  nsExec::ExecToLog 'taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}"'
  Sleep 500
!macroend
