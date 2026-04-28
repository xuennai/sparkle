import React, { useEffect, useState, useCallback, useRef } from 'react'
import { Button, Spinner, Card, CardBody, Chip, Divider } from '@heroui/react'
import { Modal } from '@heroui-v3/react'
import { useAppConfig } from '@renderer/hooks/use-app-config'
import { serviceStatus, quickServiceStatus, testServiceConnection } from '@renderer/utils/ipc'

interface Props {
  onChange: (open: boolean) => void
  onInit: () => Promise<void>
  onInstall: () => Promise<void>
  onUninstall: () => Promise<void>
  onStart: () => Promise<void>
  onRestart: () => Promise<void>
  onStop: () => Promise<void>
}

type ServiceStatusType = 'running' | 'stopped' | 'not-installed' | 'unknown' | 'need-init'
type ConnectionStatusType = 'connected' | 'disconnected' | 'checking' | 'unknown'

const ServiceModal: React.FC<Props> = (props) => {
  const { onChange, onInit, onInstall, onUninstall, onStart, onStop, onRestart } = props
  useAppConfig()
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState<ServiceStatusType | null>(null)
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatusType>('checking')
  const loadingRef = useRef(false)

  const checkServiceConnection = useCallback(async (): Promise<void> => {
    if (status === 'running') {
      try {
        setConnectionStatus('checking')
        const connected = await testServiceConnection()
        setConnectionStatus(connected ? 'connected' : 'disconnected')
      } catch {
        setConnectionStatus('disconnected')
      }
    } else {
      setConnectionStatus('disconnected')
    }
  }, [status])

  useEffect(() => {
    const checkStatus = async (): Promise<void> => {
      try {
        const result = await serviceStatus()
        setStatus(result)
      } catch {
        setStatus('not-installed')
      }
    }
    checkStatus()
  }, [])

  useEffect(() => {
    checkServiceConnection()
  }, [status, checkServiceConnection])

  const handleAction = async (
    action: () => Promise<void>,
    options?: { isStart?: boolean; isUninstall?: boolean }
  ): Promise<void> => {
    setLoading(true)
    loadingRef.current = true
    const { isStart, isUninstall } = options ?? {}

    try {
      await action()

      // 卸载/停止操作：乐观更新，立即反映状态变更，后台异步刷新
      if (isUninstall) {
        setStatus('not-installed')
        setConnectionStatus('disconnected')
        // 后台快速检查，不阻塞 UI
        quickServiceStatus()
          .then((result) => {
            if (!loadingRef.current) return
            setStatus(result as ServiceStatusType)
          })
          .catch(() => {})
        // 直接释放 loading，让用户可进行后续操作
        setLoading(false)
        loadingRef.current = false
        return
      }

      // 启动操作：需要轮询等待服务就绪
      if (isStart) {
        let retries = 8
        while (retries > 0) {
          await new Promise((resolve) => setTimeout(resolve, 1000))
          const result = await quickServiceStatus()
          if (result === 'running') {
            setStatus('running')
            await checkServiceConnection()
            setLoading(false)
            loadingRef.current = false
            return
          }
          retries--
        }
        // 轮询结束后获取最终状态
        const finalResult = await serviceStatus()
        setStatus(finalResult as ServiceStatusType)
        await checkServiceConnection()
        setLoading(false)
        loadingRef.current = false
        return
      }

      // 安装/初始化等常规操作
      let result = await quickServiceStatus()
      if (result === 'not-installed' || result === 'stopped') {
        // 可能服务还没完全启动，再等一次
        await new Promise((resolve) => setTimeout(resolve, 1000))
        result = await serviceStatus()
      }
      setStatus(result as ServiceStatusType)
      await checkServiceConnection()
    } catch (e) {
      const errorMsg = String(e)
      if (errorMsg.includes('用户取消操作') || errorMsg.includes('UserCancelledError')) {
        const result = await serviceStatus()
        setStatus(result as ServiceStatusType)
        await checkServiceConnection()
        return
      }
      alert(e)
    } finally {
      if (loadingRef.current) {
        setLoading(false)
        loadingRef.current = false
      }
    }
  }

  const getStatusText = (): string => {
    if (status === null) return '检查中'
    switch (status) {
      case 'running':
        return '运行中'
      case 'stopped':
        return '已停止'
      case 'not-installed':
        return '未安装'
      case 'need-init':
        return '需要初始化'
      default:
        return '未知状态'
    }
  }

  const getConnectionStatusText = (): string => {
    switch (connectionStatus) {
      case 'connected':
        return '已连接'
      case 'disconnected':
        return '未连接'
      case 'checking':
        return '检测中'
      default:
        return '未知'
    }
  }

  return (
    <Modal>
      <Modal.Backdrop
        isOpen={true}
        onOpenChange={onChange}
        variant="blur"
        className="top-12 h-[calc(100%-48px)]"
      >
        <Modal.Container scroll="inside">
          <Modal.Dialog className="w-112.5">
            <Modal.Header className="flex-col gap-1">
              <Modal.Heading>Sparkle 服务管理</Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              <div className="space-y-4">
                <Card
                  shadow="sm"
                  className="border-none bg-linear-to-br from-default-50 to-default-100"
                >
                  <CardBody className="py-4">
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">服务状态</span>
                      </div>
                      {status === null ? (
                        <Chip
                          color="default"
                          variant="flat"
                          size="sm"
                          startContent={<Spinner size="sm" color="current" />}
                        >
                          检查中...
                        </Chip>
                      ) : (
                        <Chip
                          color={
                            status === 'running'
                              ? 'success'
                              : status === 'stopped'
                                ? 'warning'
                                : status === 'not-installed'
                                  ? 'danger'
                                  : status === 'need-init'
                                    ? 'warning'
                                    : 'default'
                          }
                          variant="flat"
                          size="sm"
                        >
                          {getStatusText()}
                        </Chip>
                      )}
                    </div>

                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">连接状态</span>
                      </div>
                      {connectionStatus === 'checking' ? (
                        <Chip
                          color="default"
                          variant="flat"
                          size="sm"
                          startContent={<Spinner size="sm" color="current" />}
                        >
                          检测中...
                        </Chip>
                      ) : (
                        <Chip
                          color={
                            connectionStatus === 'connected'
                              ? 'success'
                              : connectionStatus === 'disconnected'
                                ? 'danger'
                                : 'default'
                          }
                          variant="flat"
                          size="sm"
                        >
                          {getConnectionStatusText()}
                        </Chip>
                      )}
                    </div>
                  </CardBody>
                </Card>

                <Divider />

                <div className="text-xs text-default-500 space-y-2">
                  <div className="flex items-start gap-2">
                    <span>提供系统代理设置和核心进程管理的提权功能</span>
                  </div>
                  <div className="flex items-start gap-2">
                    <span>未安装状态下部分高级功能将无法使用</span>
                  </div>
                </div>
              </div>
            </Modal.Body>
            <Modal.Footer className="flex-col gap-2 sm:flex-row">
              <Button
                size="sm"
                variant="light"
                onPress={() => onChange(false)}
                isDisabled={loading}
                className="sm:mr-auto"
              >
                关闭
              </Button>

              {status === 'unknown' ? null : status === 'not-installed' ? (
                <Button
                  size="sm"
                  color="primary"
                  variant="shadow"
                  onPress={() => handleAction(onInstall)}
                  isLoading={loading}
                >
                  安装服务
                </Button>
              ) : (
                <>
                  <Button
                    size="sm"
                    color="primary"
                    variant="flat"
                    onPress={() => handleAction(onInit)}
                    isLoading={loading}
                  >
                    初始化
                  </Button>
                  <Button
                    size="sm"
                    color="primary"
                    variant="flat"
                    onPress={() => handleAction(onRestart)}
                    isLoading={loading}
                  >
                    重启
                  </Button>
                  {status === 'running' || status === 'need-init' ? (
                    <Button
                      size="sm"
                      color="warning"
                      variant="flat"
                      onPress={() => handleAction(onStop)}
                      isLoading={loading}
                    >
                      停止
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      color="success"
                      variant="shadow"
                      onPress={() => handleAction(onStart, { isStart: true })}
                      isLoading={loading}
                    >
                      启动
                    </Button>
                  )}
                  <Button
                    size="sm"
                    color="danger"
                    variant="flat"
                    onPress={() => handleAction(onUninstall, { isUninstall: true })}
                    isLoading={loading}
                  >
                    卸载
                  </Button>
                </>
              )}
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  )
}

export default ServiceModal
