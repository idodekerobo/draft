'use client'

import * as React from 'react'
import { renderOrbScene, setupCanvasDpr } from './canvas-utils'
import { clamp } from './math'
import { presetFor } from './presets'
import { RENDERERS } from './renderers'
import type { ThinkingOrbMode, ThinkingOrbProps } from './types'

const DEFAULT_FRAME: [number, number] = [240, 240]

function getDocumentTheme() {
  const root = document.documentElement
  return root.classList.contains('dark') ||
    (!root.classList.contains('light') && window.matchMedia('(prefers-color-scheme: dark)').matches)
}

function subscribeToTheme(onChange: () => void) {
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  const query = window.matchMedia('(prefers-color-scheme: dark)')
  query.addEventListener('change', onChange)
  return () => {
    observer.disconnect()
    query.removeEventListener('change', onChange)
  }
}

export interface BaseThinkingOrbProps extends Omit<ThinkingOrbProps, 'variant'> {
  mode: ThinkingOrbMode
  caption?: string
  summary?: string
  frame?: [number, number]
}

export function BaseThinkingOrb({
  mode,
  surface = 'auto',
  scale = 0.72,
  speed = 1,
  size = 240,
  playback = 'play',
  caption = 'Thinking',
  summary = 'Interactive particle state',
  frame = DEFAULT_FRAME,
  className = '',
  style,
  ...props
}: BaseThinkingOrbProps) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null)
  const containerRef = React.useRef<HTMLDivElement | null>(null)

  const documentIsDark = React.useSyncExternalStore(subscribeToTheme, getDocumentTheme, () => false)
  const isDark = surface === 'ink' || (surface === 'auto' && documentIsDark)

  React.useEffect(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return

    let animationFrameId = 0
    let isDestroyed = false
    let isIntersecting = true
    let lastRenderTime = 0
    let accumulatedTime = 0
    let lastStamp = performance.now()

    const mediaReducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')

    const shouldAnimate = () =>
      !isDestroyed && isIntersecting && !document.hidden && playback === 'play' && mediaReducedMotion?.matches !== true

    const render = (now: number) => {
      animationFrameId = 0
      if (isDestroyed) return

      const delta = (now - lastStamp) * 0.001
      lastStamp = now

      if (shouldAnimate()) {
        accumulatedTime += delta * Math.max(Number(speed) || 1, 0.05)
      }

      // Throttle render to ~45-60fps
      if (!lastRenderTime || now - lastRenderTime >= 1000 / 45) {
        const rect = canvas.getBoundingClientRect()
        const { ctx, w, h } = setupCanvasDpr(canvas, rect.width || frame[0], rect.height || frame[1])
        ctx.clearRect(0, 0, w, h)

        const innerSize = Math.max(8, Math.min(w, h) * clamp(Number(scale) || 0.72))
        const { speed: presetSpeed, opts } = presetFor(mode, innerSize)

        ctx.save()
        ctx.translate((w - innerSize) / 2, (h - innerSize) / 2)
        const sceneTime = shouldAnimate() ? accumulatedTime * presetSpeed : 0.6 * presetSpeed
        const scene = RENDERERS[mode](innerSize, sceneTime, opts)
        renderOrbScene(ctx, scene, isDark)
        ctx.restore()

        lastRenderTime = now
      }

      if (shouldAnimate()) {
        animationFrameId = requestAnimationFrame(render)
      }
    }

    const triggerRender = () => {
      if (animationFrameId) cancelAnimationFrame(animationFrameId)
      lastStamp = performance.now()
      lastRenderTime = 0
      render(performance.now())
    }

    const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => triggerRender()) : null
    resizeObserver?.observe(container)

    const intersectionObserver =
      typeof IntersectionObserver !== 'undefined'
        ? new IntersectionObserver(
            ([entry]) => {
              isIntersecting = entry?.isIntersecting !== false
              triggerRender()
            },
            { rootMargin: '100px', threshold: 0.01 },
          )
        : null
    intersectionObserver?.observe(container)

    const onVisibilityChange = () => triggerRender()
    document.addEventListener('visibilitychange', onVisibilityChange)

    const onReducedMotionChange = () => triggerRender()
    mediaReducedMotion?.addEventListener?.('change', onReducedMotionChange)

    triggerRender()

    return () => {
      isDestroyed = true
      if (animationFrameId) cancelAnimationFrame(animationFrameId)
      resizeObserver?.disconnect()
      intersectionObserver?.disconnect()
      document.removeEventListener('visibilitychange', onVisibilityChange)
      mediaReducedMotion?.removeEventListener?.('change', onReducedMotionChange)
    }
  }, [mode, scale, speed, playback, isDark, frame])

  const [frameW, frameH] = frame

  return (
    <figure
      ref={containerRef}
      className={`relative flex items-center justify-center overflow-hidden isolate select-none ${className}`}
      style={{
        width: typeof size === 'number' ? `${size}px` : size,
        height: typeof size === 'number' ? `${size}px` : size,
        maxWidth: '100%',
        margin: 0,
        ...style,
      }}
      data-playback={playback}
      {...props}
    >
      <canvas
        ref={canvasRef}
        className="block max-h-full max-w-full"
        style={{
          width: '100%',
          height: 'auto',
          aspectRatio: `${frameW} / ${frameH}`,
        }}
        role="img"
        aria-label={`${caption}. ${summary}`}
      />
      <figcaption className="sr-only">
        {caption}: {summary}
      </figcaption>
    </figure>
  )
}
