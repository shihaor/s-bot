; 自定义安装前检查：对比已安装版本，处理「升级 / 覆盖 / 降级」
; electron-builder 会在 .onInit 里调用 customInit 宏
!include "WordFunc.nsh"

!macro customInit
  ; 读取已安装版本（优先当前用户 HKCU，再兜底所有用户 HKLM）
  ReadRegStr $0 HKCU "${UNINSTALL_REGISTRY_KEY}" "DisplayVersion"
  ${If} $0 == ""
    ReadRegStr $0 HKLM "${UNINSTALL_REGISTRY_KEY}" "DisplayVersion"
  ${EndIf}

  ${If} $0 != ""
    ${VersionCompare} "$0" "${VERSION}" $1
    ${If} $1 == 1
      ; 已安装版本更高 → 降级，提示但不阻止
      MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 "检测到已安装更高版本 $0，当前安装包是 ${VERSION}。$\r$\n不建议降级，可能丢失新版功能。$\r$\n$\r$\n仍要继续降级安装吗？" IDYES downgrade_ok
      Abort
      downgrade_ok:
    ${ElseIf} $1 == 0
      ; 版本相同 → 可选择覆盖
      MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON1 "已安装相同版本 $0，是否覆盖安装？" IDYES overwrite_ok
      Abort
      overwrite_ok:
    ${EndIf}
    ; $1 == 2 表示已安装版本更低 → 正常升级，不提示
  ${EndIf}
!macroend
