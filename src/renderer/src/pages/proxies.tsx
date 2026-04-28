import React from 'react';
import BasePage from '@renderer/components/base/base-page'
import CollapseInput from '@renderer/components/base/collapse-input'
import ProxyItem from '@renderer/components/proxies/proxy-item'
import ProxySettingModal from '@renderer/components/proxies/proxy-setting-modal'
import { Button, Card, CardBody, Chip } from '@heroui/react'
import { Avatar } from '@heroui-v3/react'
import { useAppConfig } from '@renderer/hooks/use-app-config'
import {
  getImageDataURL,
  mihomoChangeProxy,
  mihomoCloseConnections,
  mihomoGroupDelay,
  mihomoProxyDelay
} from '@renderer/utils/ipc'
import { FaLocationCrosshairs } from 'react-icons/fa6'
import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { IoIosArrowBack } from 'react-icons/io'
import { MdDoubleArrow, MdOutlineSpeed, MdTune } from 'react-icons/md'
import { useGroups } from '@renderer/hooks/use-groups'
import { includesIgnoreCase } from '@renderer/utils/includes'
import { useControledMihomoConfig } from '@renderer/hooks/use-controled-mihomo-config'
import { runDelayTestsWithConcurrency } from '@renderer/utils/delay-test'
import { motion, AnimatePresence } from 'framer-motion'

type ProxyLike = ControllerProxiesDetail | ControllerGroupDetail

const EMPTY_PROXIES: ProxyLike[] = []
const CHUNK_SIZE = 50

function getProxyDelay(proxy: ProxyLike): number {
  return proxy.history.length > 0 ? proxy.history[proxy.history.length - 1].delay : -1
}

function compareProxyDelay(a: ProxyLike, b: ProxyLike): number {
  const delayA = getProxyDelay(a)
  const delayB = getProxyDelay(b)
  if (delayA === -1) return -1
  if (delayB === -1) return 1
  if (delayA === 0) return 1
  if (delayB === 0) return -1
  return delayA - delayB
}

const Proxies: React.FC = () => {
  const { controledMihomoConfig } = useControledMihomoConfig()
  const { mode = 'rule' } = controledMihomoConfig || {}
  const { groups = [], mutate } = useGroups()
  const { appConfig } = useAppConfig()
  const {
    proxyDisplayLayout = 'double',
    groupDisplayLayout = 'double',
    proxyDisplayOrder = 'default',
    autoCloseConnection = true,
    closeMode = 'all',
    proxyCols = 'auto',
    delayTestUrlScope = 'group',
    delayTestUseGroupApi = false,
    delayTestConcurrency
  } = appConfig || {}

  const [isOpen, setIsOpen] = useState<boolean[]>(Array(groups.length).fill(false))
  const [delaying, setDelaying] = useState<boolean[]>(Array(groups.length).fill(false))
  const [searchValue, setSearchValue] = useState<string[]>(Array(groups.length).fill(''))
  const [isSettingModalOpen, setIsSettingModalOpen] = useState(false)
  const [displayCounts, setDisplayCounts] = useState<number[]>(Array(groups.length).fill(CHUNK_SIZE))

  const scrollContainerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setIsOpen((prev) => (prev.length === groups.length ? prev : groups.map((_, index) => prev[index] || false)))
    setDelaying((prev) => (prev.length === groups.length ? prev : groups.map((_, index) => prev[index] || false)))
    setSearchValue((prev) => (prev.length === groups.length ? prev : groups.map((_, index) => prev[index] || '')))
    setDisplayCounts((prev) => (prev.length === groups.length ? prev : groups.map((_, index) => prev[index] || CHUNK_SIZE)))
  }, [groups])

  const allProxies = useMemo(() => {
    return groups.map((group, index) => {
      const searchText = searchValue[index] || ''
      let groupProxies = searchText
        ? group.all.filter((proxy) => proxy && includesIgnoreCase(proxy.name, searchText))
        : (group.all as ProxyLike[])

      if (proxyDisplayOrder === 'delay') {
        groupProxies = [...groupProxies].sort(compareProxyDelay)
      } else if (proxyDisplayOrder === 'name') {
        groupProxies = [...groupProxies].sort((a, b) => a.name.localeCompare(b.name))
      }
      return groupProxies
    })
  }, [groups, proxyDisplayOrder, searchValue])

  useEffect(() => {
    let timer: number
    let hasMore = false
    let isInitialExpansion = false
    const nextCounts = [...displayCounts]

    for (let i = 0; i < isOpen.length; i++) {
      if (isOpen[i] && allProxies[i]) {
        if (nextCounts[i] < allProxies[i].length) {
          if (nextCounts[i] === CHUNK_SIZE) {
            isInitialExpansion = true
          }
          nextCounts[i] = Math.min(nextCounts[i] + CHUNK_SIZE, allProxies[i].length)
          hasMore = true
        }
      }
    }

    if (hasMore) {
      const delay = isInitialExpansion ? 350 : 30
      timer = window.setTimeout(() => {
        setDisplayCounts(nextCounts)
      }, delay)
    }

    return () => clearTimeout(timer)
  }, [isOpen, displayCounts, allProxies])

  const onChangeProxy = useCallback(
    async (group: string, proxy: string): Promise<void> => {
      await mihomoChangeProxy(group, proxy)
      if (autoCloseConnection) {
        if (closeMode === 'all') await mihomoCloseConnections()
        else if (closeMode === 'group') await mihomoCloseConnections(group)
      }
      mutate()
    },
    [autoCloseConnection, closeMode, mutate]
  )

  const getDelayTestUrl = useCallback(
    (group?: ControllerMixedGroup): string | undefined => (delayTestUrlScope === 'global' ? undefined : group?.testUrl),
    [delayTestUrlScope]
  )

  const onProxyDelay = useCallback(
    async (proxy: string, group?: ControllerMixedGroup): Promise<ControllerProxiesDelay> => {
      return await mihomoProxyDelay(proxy, getDelayTestUrl(group))
    },
    [getDelayTestUrl]
  )

  const setGroupDelaying = useCallback((index: number, value: boolean): void => {
    setDelaying((prev) => {
      const newDelaying = [...prev]
      newDelaying[index] = value
      return newDelaying
    })
  }, [])

  const onGroupDelay = useCallback(
    async (index: number): Promise<void> => {
      const group = groups[index]
      if (!group) return

      const proxies = allProxies[index].length > 0 ? allProxies[index] : group.all
      if (proxies.length === 0) return

      if (!isOpen[index]) {
        setIsOpen((prev) => {
          const newOpen = [...prev]
          newOpen[index] = true
          return newOpen
        })
      }

      const testUrl = getDelayTestUrl(group)
      setGroupDelaying(index, true)

      try {
        if (delayTestUseGroupApi) {
          await mihomoGroupDelay(group.name, testUrl)
          return
        }
        await runDelayTestsWithConcurrency(proxies, delayTestConcurrency, async (proxy) => {
          try {
            await mihomoProxyDelay(proxy.name, testUrl)
          } catch { }
        })
      } catch { } finally {
        mutate()
        setGroupDelaying(index, false)
      }
    },
    [allProxies, groups, isOpen, delayTestUseGroupApi, delayTestConcurrency, mutate, getDelayTestUrl, setGroupDelaying]
  )

  const toggleOpen = useCallback((index: number) => {
    setIsOpen((prev) => {
      const newOpen = [...prev]
      newOpen[index] = !newOpen[index]
      return newOpen
    })

    setDisplayCounts((prev) => {
      const newCounts = [...prev]
      newCounts[index] = CHUNK_SIZE
      return newCounts
    })
  }, [])

  const updateSearchValue = useCallback((index: number, value: string) => {
    setSearchValue((prev) => {
      const newSearchValue = [...prev]
      newSearchValue[index] = value
      return newSearchValue
    })

    setDisplayCounts((prev) => {
      const newCounts = [...prev]
      newCounts[index] = CHUNK_SIZE
      return newCounts
    })
  }, [])

  const scrollToCurrentProxy = useCallback(
    (index: number) => {
      const proxies = allProxies[index].length > 0 ? allProxies[index] : groups[index].all
      const targetInnerIndex = proxies.findIndex((proxy) => proxy.name === groups[index].now)

      if (!isOpen[index]) {
        setIsOpen((prev) => {
          const newOpen = [...prev]
          newOpen[index] = true
          return newOpen
        })
      }

      // 【核心防 Bug】：定位节点时，必须强行把流式加载的额度拉到目标节点的位置，否则由于节点还没渲染出来，会滚不到对应的地方
      setDisplayCounts((prev) => {
        const newCounts = [...prev]
        if (newCounts[index] < targetInnerIndex + 10) {
          newCounts[index] = targetInnerIndex + 30
        }
        return newCounts
      })

      setTimeout(() => {
        const targetElement = document.getElementById(`proxy-item-${groups[index].name}-${groups[index].now}`)
        if (targetElement && scrollContainerRef.current) {
          targetElement.scrollIntoView({ behavior: 'smooth', block: 'center' })
        }
      }, 150)
    },
    [isOpen, groups, allProxies]
  )

  return (
    <BasePage
      title="代理组"
      header={
        <Button size="sm" isIconOnly variant="light" className="app-nodrag" title="代理组设置" onPress={() => setIsSettingModalOpen(true)}>
          <MdTune className="text-lg" />
        </Button>
      }
    >
      {isSettingModalOpen && <ProxySettingModal onClose={() => setIsSettingModalOpen(false)} />}

      {mode === 'direct' ? (
        <div className="h-full w-full flex justify-center items-center">
          <div className="flex flex-col items-center">
            <MdDoubleArrow className="text-foreground-500 text-[100px]" />
            <h2 className="text-foreground-500 text-[20px]">直连模式</h2>
          </div>
        </div>
      ) : (
        <div ref={scrollContainerRef} className="h-[calc(100vh-50px)] overflow-y-auto overflow-x-hidden no-scrollbar pb-10">
          <div className="flex flex-col w-full">
            {groups.map((group, groupIndex) => {
              const isExpanded = isOpen[groupIndex]
              const proxies = allProxies[groupIndex] || EMPTY_PROXIES

              // 【流式渲染切片】：只渲染当前允许的数量
              const visibleProxies = proxies.slice(0, displayCounts[groupIndex] || CHUNK_SIZE)

              if (group.icon && group.icon.startsWith('http') && !localStorage.getItem(group.icon)) {
                getImageDataURL(group.icon).then((dataURL) => {
                  localStorage.setItem(group.icon, dataURL)
                  mutate()
                })
              }

              return (
                <div key={group.name} className="w-full pt-2 px-2">
                  <Card
                    as="div"
                    isPressable
                    fullWidth
                    className="cursor-pointer data-[pressed=true]:!scale-[0.995] transition-transform z-10"
                    role="button"
                    tabIndex={0}
                    onClick={() => toggleOpen(groupIndex)}
                  >
                    <CardBody className="w-full h-14">
                      <div className="flex justify-between h-full">
                        <div className="flex text-ellipsis overflow-hidden whitespace-nowrap h-full">
                          {group.icon ? (
                            <Avatar
                              className="mr-2 h-8 w-8 shrink-0 bg-transparent overflow-visible! rounded-none!"
                              size="sm"
                            >
                              <Avatar.Image
                                className="object-contain"
                                src={
                                  group.icon.startsWith('<svg')
                                    ? `data:image/svg+xml;utf8,${group.icon}`
                                    : localStorage.getItem(group.icon) || group.icon
                                }
                              />
                            </Avatar>
                          ) : null}
                          <div className={`flex flex-col h-full ${groupDisplayLayout === 'double' ? '' : 'justify-center'}`}>
                            <div className={`text-ellipsis overflow-hidden whitespace-nowrap leading-tight ${groupDisplayLayout === 'double' ? 'text-md flex-5 flex items-center' : 'text-lg'}`}>
                              <span className="flag-emoji inline-block">{group.name}</span>
                              {groupDisplayLayout === 'single' && (
                                <>
                                  <div title={group.type} className="inline ml-2 text-sm text-foreground-500">
                                    {group.type}
                                  </div>
                                  <div className="inline flag-emoji ml-2 text-sm text-foreground-500">
                                    {group.now}
                                  </div>
                                </>
                              )}
                            </div>
                            {groupDisplayLayout === 'double' && (
                              <div className="text-ellipsis whitespace-nowrap text-[10px] text-foreground-500 leading-tight flex-3 flex items-center">
                                <span>{group.type}</span>
                                <span className="flag-emoji ml-1 inline-block">{group.now}</span>
                              </div>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center">
                          <div className="flex items-center" onClick={(e) => e.stopPropagation()}>
                            <Chip size="sm" className="my-1 mr-2">{group.all.length}</Chip>
                            <CollapseInput title="搜索节点" value={searchValue[groupIndex]} onValueChange={(v) => updateSearchValue(groupIndex, v)} />
                            <Button title="定位到当前节点" variant="light" size="sm" isIconOnly onPress={() => scrollToCurrentProxy(groupIndex)}>
                              <FaLocationCrosshairs className="text-lg text-foreground-500" />
                            </Button>
                            <Button title="延迟测试" variant="light" isLoading={delaying[groupIndex]} size="sm" isIconOnly onPress={() => onGroupDelay(groupIndex)}>
                              <MdOutlineSpeed className="text-lg text-foreground-500" />
                            </Button>
                          </div>
                          <IoIosArrowBack className={`transition duration-300 ml-2 h-8 text-lg text-foreground-500 flex items-center ${isExpanded ? '-rotate-90' : ''}`} />
                        </div>
                      </div>
                    </CardBody>
                  </Card>

                  <AnimatePresence initial={false}>
                    {isExpanded && (
                      <motion.div
                        key={`content-${group.name}`}
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.35, ease: [0.33, 1, 0.68, 1] }}
                        className="overflow-hidden"
                      >
                        <div
                          style={proxyCols !== 'auto' ? { gridTemplateColumns: `repeat(${proxyCols}, minmax(0, 1fr))` } : {}}
                          className={`grid ${proxyCols === 'auto' ? 'sm:grid-cols-2 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5' : ''} gap-2 pt-2 pb-2`}
                        >
                          {/* 【切片渲染】：只渲染 visibleProxies */}
                          {visibleProxies.map((proxy) => (
                            <div key={proxy.name} id={`proxy-item-${group.name}-${proxy.name}`}>
                              <ProxyItem
                                mutateProxies={mutate}
                                onProxyDelay={onProxyDelay}
                                onSelect={onChangeProxy}
                                proxy={proxy}
                                group={group}
                                proxyDisplayLayout={proxyDisplayLayout}
                                selected={proxy.name === group.now}
                              />
                            </div>
                          ))}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </BasePage>
  )
}

export default Proxies