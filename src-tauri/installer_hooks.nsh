; ==============================================================================
; Odoo Print Gateway - NSIS Lifecycle Service Hooks (Tauri v2 NSIS_HOOK_*)
; ==============================================================================


!macro NSIS_HOOK_PREINSTALL
  DetailPrint "Stopping existing Odoo Print Agent..."
  nsExec::Exec 'net stop OdooPrintAgent'
  nsExec::Exec 'sc stop OdooPrintAgent'
  nsExec::Exec 'taskkill /F /T /IM OdooPrintAgent.exe'
!macroend


!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "Configuring Odoo Print Agent Windows Service..."
  IfFileExists "$INSTDIR\resources\OdooPrintAgent.exe" 0 +4
    nsExec::Exec '"$INSTDIR\resources\OdooPrintAgent.exe" -service install'
    nsExec::Exec '"$INSTDIR\resources\OdooPrintAgent.exe" -service start'
    Goto +3


  IfFileExists "$INSTDIR\OdooPrintAgent.exe" 0 +3
    nsExec::Exec '"$INSTDIR\OdooPrintAgent.exe" -service install'
    nsExec::Exec '"$INSTDIR\OdooPrintAgent.exe" -service start'
!macroend


!macro NSIS_HOOK_PREUNINSTALL
  DetailPrint "Stopping and removing Odoo Print Agent Windows Service..."
  IfFileExists "$INSTDIR\resources\OdooPrintAgent.exe" 0 +4
    nsExec::Exec '"$INSTDIR\resources\OdooPrintAgent.exe" -service stop'
    nsExec::Exec '"$INSTDIR\resources\OdooPrintAgent.exe" -service uninstall'
    Goto +3


  IfFileExists "$INSTDIR\OdooPrintAgent.exe" 0 +3
    nsExec::Exec '"$INSTDIR\OdooPrintAgent.exe" -service stop'
    nsExec::Exec '"$INSTDIR\OdooPrintAgent.exe" -service uninstall'
!macroend
