!ifndef BUILD_UNINSTALLER

!macro customHeader
  Var sparkleServiceWasRunning
!macroend

; 覆盖安装时不清除原文件夹，保留已存在的文件（如用户自定义的 sparkle-service.exe）
; 卸载时只清空文件夹内部所有内容，保留最外层的安装目录壳子
!macro customRemoveFiles
  RMDir /r "$INSTDIR\*"
!macroend


!macro ServiceOutputContains NEEDLE RESULT
  StrCpy ${RESULT} "false"
  StrCpy $R5 0
  StrLen $R6 $R3
  StrLen $R8 "${NEEDLE}"
  ${Do}
    StrCpy $R9 $R3 $R8 $R5
    ${If} $R9 == "${NEEDLE}"
      StrCpy ${RESULT} "true"
      ${Break}
    ${EndIf}
    IntOp $R5 $R5 + 1
  ${LoopUntil} $R5 >= $R6
!macroend

!macro QuerySparkleServiceState RESULT
  nsExec::ExecToStack '"$SYSDIR\sc.exe" query SparkleService'
  Pop $R2
  Pop $R3

  StrCpy ${RESULT} "not-installed"
  ${If} $R2 == 0
    !insertmacro ServiceOutputContains "RUNNING" $R4
    ${If} $R4 == "true"
      StrCpy ${RESULT} "running"
    ${Else}
      !insertmacro ServiceOutputContains "STOP_PENDING" $R4
      ${If} $R4 == "true"
        StrCpy ${RESULT} "stop-pending"
      ${Else}
        !insertmacro ServiceOutputContains "STOPPED" $R4
        ${If} $R4 == "true"
          StrCpy ${RESULT} "stopped"
        ${Else}
          StrCpy ${RESULT} "unknown"
        ${EndIf}
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

!macro WaitSparkleServiceStopped
  StrCpy $R0 0
  ${Do}
    !insertmacro QuerySparkleServiceState $R1
    ${If} $R1 == "stopped"
    ${OrIf} $R1 == "not-installed"
      ${Break}
    ${EndIf}
    Sleep 500
    IntOp $R0 $R0 + 1
  ${LoopUntil} $R0 >= 30

  !insertmacro QuerySparkleServiceState $R1
  ${If} $R1 != "stopped"
  ${AndIf} $R1 != "not-installed"
    MessageBox MB_ICONSTOP "SparkleService is still running. Please stop the service and run the installer again."
    Abort
  ${EndIf}
!macroend

!macro StopSparkleServiceIfRunning
  !insertmacro QuerySparkleServiceState $R1

  ${If} $R1 != "stopped"
  ${AndIf} $R1 != "not-installed"
    StrCpy $sparkleServiceWasRunning "true"
    DetailPrint "Stopping Sparkle service"
    nsExec::ExecToStack '"$SYSDIR\sc.exe" stop SparkleService'
    Pop $R2
    Pop $R3
    !insertmacro WaitSparkleServiceStopped
  ${EndIf}
!macroend

!macro customInit
  ; [DEBUG] 创建 NSIS 调试日志文件，记录安装流程每一步
  Push $R0
  FileOpen $R0 "$APPDATA\Sparkle-NSIS-Debug.log" w
  FileWrite $R0 "=== Sparkle Installer Debug Log ===$\r$\n"
  FileWrite $R0 "INSTDIR: $INSTDIR$\r$\n"
  FileWrite $R0 "--- customInit Begin ---$\r$\n"
  FileWrite $R0 "Killing conflicting processes...$\r$\n"
  FileClose $R0
  Pop $R0

  ; 检测 sparkle.exe 是否在运行，弹窗让用户决定是否关闭
  nsExec::ExecToStack 'tasklist /FI "IMAGENAME eq sparkle.exe" /NH'
  Pop $R2
  Pop $R3

  StrCpy $R7 "false"
  ${If} $R2 == 0
    !insertmacro ServiceOutputContains "sparkle.exe" $R7
  ${EndIf}

  ${If} $R7 == "true"
    MessageBox MB_YESNO|MB_ICONQUESTION \
      "检测到 Sparkle 正在运行。$\r$\n是否自动关闭 Sparkle 以继续安装？$\r$\n$\r$\n选择「是」将关闭 Sparkle 后继续安装。$\r$\n选择「否」将退出安装程序。" \
      IDYES doKillAll IDNO doAbort
    doKillAll:
      nsExec::ExecToStack 'taskkill /F /IM "sparkle.exe" /T'
      nsExec::ExecToStack 'taskkill /F /IM "sparkle-service.exe" /T'
      nsExec::ExecToStack 'taskkill /F /IM "mihomo-*.exe" /T'
      Goto afterProcessCheck
    doAbort:
      Abort
  ${Else}
    ; sparkle.exe 不在运行，但仍需清理可能残留的后台进程
    nsExec::ExecToStack 'taskkill /F /IM "sparkle-service.exe" /T'
    nsExec::ExecToStack 'taskkill /F /IM "mihomo-*.exe" /T'
  ${EndIf}
  afterProcessCheck:

  StrCpy $sparkleServiceWasRunning "false"
  !insertmacro StopSparkleServiceIfRunning

  ; [DEBUG] 日志：服务状态处理完毕
  Push $R1
  FileOpen $R1 "$APPDATA\Sparkle-NSIS-Debug.log" a
  FileWrite $R1 "sparkleServiceWasRunning: $sparkleServiceWasRunning$\r$\n"
  FileWrite $R1 "Deleting RegKey HKLM...$\r$\n"
  FileClose $R1
  Pop $R1

  ; 覆盖安装：删除旧版注册表项，让安装器跳过"卸载旧版"流程，直接覆盖写入
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\sparkle.app"

  ; [DEBUG] 日志：HKLM 删除完毕
  Push $R2
  FileOpen $R2 "$APPDATA\Sparkle-NSIS-Debug.log" a
  FileWrite $R2 "HKLM RegKey deleted (or not present)$\r$\n"
  FileWrite $R2 "Deleting RegKey HKCU...$\r$\n"
  FileClose $R2
  Pop $R2

  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\sparkle.app"

  ; [DEBUG] 日志：HKCU 删除完毕，customInit 结束
  Push $R3
  FileOpen $R3 "$APPDATA\Sparkle-NSIS-Debug.log" a
  FileWrite $R3 "HKCU RegKey deleted (or not present)$\r$\n"
  FileWrite $R3 "--- customInit End ---$\r$\n"
  FileWrite $R3 "==================================$\r$\n"
  FileClose $R3
  Pop $R3
!macroend

!macro customInstall
  ; [DEBUG] customInstall 开始
  Push $R4
  FileOpen $R4 "$APPDATA\Sparkle-NSIS-Debug.log" a
  FileWrite $R4 "--- customInstall Begin ---$\r$\n"
  FileWrite $R4 "sparkleServiceWasRunning: $sparkleServiceWasRunning$\r$\n"
  FileClose $R4
  Pop $R4

  ${If} $sparkleServiceWasRunning == "true"
    StrCpy $R1 "$INSTDIR\resources\files\sparkle-service.exe"
    ${If} ${FileExists} "$R1"
      DetailPrint "Starting Sparkle service: $R1"
      nsExec::ExecToLog '"$R1" service start'
      Pop $R2
      ${If} $R2 != 0
        DetailPrint "Sparkle service start exited with code $R2"
      ${EndIf}

      ; 等待服务完全进入 RUNNING 状态（最多等 10 秒）
      ; 确保重装后服务真正就绪，避免应用启动时因服务不可达而降级为直接运行模式
      DetailPrint "Waiting for Sparkle service to reach RUNNING state..."
      StrCpy $R5 0
      ${Do}
        Sleep 500
        !insertmacro QuerySparkleServiceState $R6
        ${If} $R6 == "running"
          DetailPrint "Sparkle service is now RUNNING"
          ${Break}
        ${EndIf}
        IntOp $R5 $R5 + 1
      ${LoopUntil} $R5 >= 20
      ${If} $R6 != "running"
        DetailPrint "Sparkle service did not reach RUNNING state within timeout (state=$R6)"
      ${EndIf}
    ${EndIf}
  ${EndIf}

  ; [DEBUG] customInstall 结束
  Push $R5
  FileOpen $R5 "$APPDATA\Sparkle-NSIS-Debug.log" a
  FileWrite $R5 "--- customInstall End ---$\r$\n"
  FileWrite $R5 "==================================$\r$\n"
  FileClose $R5
  Pop $R5
!macroend

!macro customInstallCompleted
  ; [DEBUG] 安装器完整结束
  Push $R6
  FileOpen $R6 "$APPDATA\Sparkle-NSIS-Debug.log" a
  FileWrite $R6 "--- customInstallCompleted ---$\r$\n"
  FileWrite $R6 "Installer finished successfully$\r$\n"
  FileWrite $R6 "==================================$\r$\n"
  FileClose $R6
  Pop $R6
!macroend

!endif
