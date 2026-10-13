!macro customInit
  ${If} $hasPerUserInstallation != "1"
    !insertmacro GetDParameter $R0
    ${If} $R0 == ""
      StrCpy $INSTDIR "$LOCALAPPDATA\MediaHub\app"
    ${EndIf}
  ${EndIf}
!macroend
