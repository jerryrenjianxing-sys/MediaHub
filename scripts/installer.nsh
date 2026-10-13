!macro customInit
  ${If} $hasPerUserInstallation != "1"
    Call GetDParameter
    ${If} $R0 == ""
      StrCpy $INSTDIR "$LOCALAPPDATA\MediaHub\app"
    ${EndIf}
  ${EndIf}
!macroend
