; A second Start menu shortcut that opens LootDen full screen, for handhelds and TVs.
; It also gives Steam and other launchers a ready-made target with --fullscreen.
!macro customInstall
  CreateShortCut "$SMPROGRAMS\LootDen (full screen).lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "--fullscreen" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0
!macroend

!macro customUnInstall
  Delete "$SMPROGRAMS\LootDen (full screen).lnk"
  ; Updates reinstall over the old copy; only a real uninstall stops LootDen starting with Windows.
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "LootDen"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "LootDen"
  ${endIf}
!macroend
