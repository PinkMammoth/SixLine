; SixLine installer additions: optional desktop shortcut (asked once; "No" in silent installs)
; and complete removal of the .tabproj association on uninstall.
!macro customInstall
  MessageBox MB_YESNO|MB_ICONQUESTION "Create a SixLine shortcut on the desktop?" /SD IDNO IDNO sixlineSkipDesktop
    CreateShortCut "$DESKTOP\SixLine.lnk" "$INSTDIR\SixLine.exe" "" "$INSTDIR\SixLine.exe" 0
  sixlineSkipDesktop:
!macroend

!macro customUnInstall
  Delete "$DESKTOP\SixLine.lnk"
  ; electron-builder removes the "SixLine Project" class; drop .tabproj too if it still points at it
  ReadRegStr $0 SHCTX "Software\Classes\.tabproj" ""
  StrCmp $0 "SixLine Project" 0 sixlineKeepExt
    DeleteRegKey SHCTX "Software\Classes\.tabproj"
  sixlineKeepExt:
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
