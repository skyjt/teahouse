<script setup lang="ts">
import { pkResultText } from '../utils/message-text'
import { tr } from '../utils/i18n'
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { MessageView } from '../../../shared/ipc'
import { pkLabel, type PkGame, type PkRpsResult } from '../../../shared/pk'
import { emojiToTwemojiCode, twemojiUrl } from '../utils/twemoji-assets'
import PantryIcon from './PantryIcon.vue'

const props = defineProps<{
  msg: MessageView
  mine: boolean
  showAction: boolean
  actionDisabled: boolean
  disabledReason: string
}>()

const emit = defineEmits<{ participate: [game: PkGame] }>()

const finalRef = computed(() => props.msg.pkRef ?? null)
const game = computed(() => finalRef.value?.game ?? 'dice')
const label = computed(() => tr(pkLabel(game.value)))
const chipIcon = computed(() => (game.value === 'dice' ? 'pk-dice' : 'pk-rps'))
const actionText = computed(() => (game.value === 'dice' ? tr('掷一下') : tr('我也来')))

const revealElement = ref<HTMLElement | null>(null)
const revealing = ref(false)
const rpsResult = computed(() => {
  const result = finalRef.value?.result
  return typeof result === 'string' ? result : null
})
const rpsSrc = computed(() => {
  if (game.value !== 'rps' || !rpsResult.value) return ''
  // 石头用 👊(1f44a) 而非 ✊(270a)：本地 twemoji 资源缺 270a.svg，1f44a 已内置且同套画风（决议 #148）
  const emoji: Record<PkRpsResult, string> = { rock: '👊', paper: '✋', scissors: '✌️' }
  return twemojiUrl(emojiToTwemojiCode(emoji[rpsResult.value]))
})
// 骰子：CSS 3D 立方体，6 面真实点数；投掷时翻滚，定格时转到结果面朝前
const diceValue = computed(() => (typeof finalRef.value?.result === 'number' ? finalRef.value.result : 1))
// 每个点数面朝前（且点阵正立）时立方体应处的 [rotateX, rotateY]
const FACE_ANGLE: Record<number, [number, number]> = {
  1: [0, 0],
  2: [-90, 0],
  3: [0, -90],
  4: [0, 90],
  5: [90, 0],
  6: [0, 180]
}
// 6 个面各自的点阵（九宫格落点，与 2D 骰面一致）
const FACE_DOTS: Record<number, Set<number>> = {
  1: new Set([4]),
  2: new Set([0, 8]),
  3: new Set([0, 4, 8]),
  4: new Set([0, 2, 6, 8]),
  5: new Set([0, 2, 4, 6, 8]),
  6: new Set([0, 2, 3, 5, 6, 8])
}
function pose(x: number, y: number): string {
  return 'rotateX(' + x + 'deg) rotateY(' + y + 'deg)'
}
const dicePose = computed(() => pose(...FACE_ANGLE[diceValue.value]))
const resultText = computed(() => {
  if (!finalRef.value) return props.msg.text
  if (revealing.value) return game.value === 'dice' ? tr('投掷中…') : tr('出拳中…')
  return pkResultText(finalRef.value)
})

let reveal: Animation | undefined
let motionPreference: MediaQueryList | undefined

function finishReveal(): void {
  reveal?.cancel()
  reveal = undefined
  revealing.value = false
  motionPreference?.removeEventListener('change', finishReveal)
  motionPreference = undefined
  document.removeEventListener('visibilitychange', finishReveal)
}

onMounted(() => {
  const duration = 800
  const elapsed = Date.now() - props.msg.ts
  if (!finalRef.value || !revealElement.value || document.hidden || elapsed < 0 || elapsed >= duration) return
  motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)')
  if (motionPreference.matches) return

  const [x, y] = FACE_ANGLE[diceValue.value]
  const transforms = game.value === 'dice'
    ? [pose(x - 160, y - 245), dicePose.value]
    : ['rotateY(-180deg)', 'rotateY(0deg)']
  reveal = revealElement.value.animate(
    transforms.map(transform => ({ transform })),
    { duration, easing: 'cubic-bezier(.22,.66,.25,1)' }
  )
  // 按消息时间衔接进度，来回切换会话时也在同一时刻定格。
  reveal.currentTime = elapsed
  revealing.value = true
  reveal.onfinish = finishReveal
  motionPreference.addEventListener('change', finishReveal)
  document.addEventListener('visibilitychange', finishReveal)
})
onUnmounted(finishReveal)
</script>

<template>
  <div class="pk-bubble" :class="{ mine, 'has-action': showAction }">
    <div class="pk-stage">
      <div v-if="game === 'dice'" ref="revealElement" class="dice-cube" :style="{ transform: dicePose }" :aria-label="tr('{0} 点', { 0: diceValue })">
        <div v-for="face in 6" :key="face" class="dice-side" :class="'s' + face">
          <span v-for="cell in 9" :key="cell" class="dice-cell">
            <span v-if="FACE_DOTS[face].has(cell - 1)" class="dice-dot"></span>
          </span>
        </div>
      </div>
      <div v-else-if="rpsSrc" ref="revealElement" class="rps-card">
        <span class="rps-face rps-front"><img :src="rpsSrc" alt="" draggable="false" /></span>
        <span class="rps-face rps-back"><PantryIcon name="pk" size="compact" /></span>
      </div>
    </div>
    <div class="pk-info">
      <span class="pk-label">
        <PantryIcon :name="chipIcon" :size="12" />
        <span>{{ label }}</span>
      </span>
      <span class="pk-result">{{ resultText }}</span>
    </div>
    <button
      v-if="showAction"
      class="pk-join"
      type="button"
      :disabled="actionDisabled"
      :title="actionDisabled ? disabledReason : actionText"
      @click="emit('participate', game)"
    >
      {{ actionText }}
    </button>
  </div>
</template>

<style scoped>
/* 茶青描边的明暗两套取值用局部变量承载——Chrome 108 不支持 color-mix，只能预置 rgba */
/* 横向卡（决议 #145）：开奖窗左 + 信息列中 + 参与按钮右，高度由 42px 开奖窗决定，从原 ~170px 垂直堆叠瘦身到 ~60px */
.pk-bubble {
  --pk-edge: rgba(var(--primary-rgb), 0.22);
  box-sizing: border-box;
  width: 132px;
  padding: 8px 9px;
  border-radius: 8px;
  background: var(--bubble-peer);
  border: 1px solid var(--line);
  display: flex;
  align-items: center;
  gap: 9px;
  overflow: hidden;
}
html[data-theme='dark'] .pk-bubble {
  --pk-edge: rgba(93, 143, 208, 0.32);
}
.pk-bubble.mine {
  background: var(--bubble-mine);
}
/* 固定卡片宽度（决议 #147）：避免「出了布」比「出了石头」短一截、动画态→定格态宽度跳变；他人含参与按钮更宽，信息列 flex:1 撑满、结果左对齐、短文字右侧留白 */
.pk-bubble.has-action {
  width: 200px;
}
/* 信息列：玩法标签（小）+ 结果文字纵向堆叠，占据开奖窗右侧 */
.pk-info {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  flex: 1;
}
.pk-label {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  color: var(--primary);
  font-size: 11px;
  font-weight: 600;
  line-height: 1.3;
}
.pk-label .pantry-icon {
  color: var(--primary);
}
.pk-result {
  color: var(--text-1);
  font-size: 13px;
  font-weight: 500;
  line-height: 1.25;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 统一开奖窗：骰子 3D 立方体与猜拳 3D 翻牌共用这一个中性凹陷窗，靠茶青描边统一；横向卡里固定 42px、不被压缩 */
.pk-stage {
  position: relative;
  flex: none;
  width: 42px;
  height: 42px;
  border-radius: 7px;
  background: var(--bg-chat);
  border: 1px solid var(--pk-edge);
  display: grid;
  place-items: center;
  box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.06);
  perspective: 240px;
}
/* 3D 骰子立方体：6 面各 translateZ(14px) 撑成 28px 见方的盒子 */
.dice-cube {
  position: relative;
  width: 28px;
  height: 28px;
  transform-style: preserve-3d;
}
.dice-side {
  position: absolute;
  inset: 0;
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  grid-template-rows: repeat(3, 1fr);
  padding: 4px;
  background: var(--bg-window);
  border: 1px solid var(--pk-edge);
  border-radius: 5px;
  box-shadow: inset 0 0 4px rgba(0, 0, 0, 0.07);
  backface-visibility: hidden;
}
.s1 {
  transform: rotateY(0deg) translateZ(14px);
}
.s2 {
  transform: rotateX(90deg) translateZ(14px);
}
.s3 {
  transform: rotateY(90deg) translateZ(14px);
}
.s4 {
  transform: rotateY(-90deg) translateZ(14px);
}
.s5 {
  transform: rotateX(-90deg) translateZ(14px);
}
.s6 {
  transform: rotateY(180deg) translateZ(14px);
}
.dice-cell {
  display: grid;
  place-items: center;
}
.dice-dot {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--text-1);
}
/* 猜拳从牌背翻到结果手势。 */
.rps-card {
  position: relative;
  width: 28px;
  height: 28px;
  transform-style: preserve-3d;
}
.rps-face {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  backface-visibility: hidden;
}
.rps-back {
  border: 1px solid var(--pk-edge);
  border-radius: var(--radius-control);
  color: var(--primary);
  transform: rotateY(180deg);
}
.rps-face img {
  width: 26px;
  height: 26px;
  display: block;
}
/* 参与按钮：开奖窗右侧小胶囊，仅他人 PK 显示，hover 实底茶青强化参与召唤 */
.pk-join {
  flex: none;
  margin-left: 2px;
  padding: 5px 11px;
  border-radius: 999px;
  border: 1px solid var(--pk-edge);
  background: var(--primary-weak);
  color: var(--primary);
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
  transition: background 140ms ease, border-color 140ms ease, color 140ms ease;
}
.pk-join:hover:not(:disabled) {
  background: var(--primary);
  border-color: var(--primary);
  color: var(--on-primary);
}
.pk-join:active:not(:disabled) {
  background: var(--primary-hover);
}
.pk-join:focus-visible {
  outline: 2px solid rgba(var(--primary-rgb), 0.35);
  outline-offset: 2px;
}
.pk-join:disabled {
  color: var(--text-3);
  background: transparent;
  border-color: var(--line);
  cursor: default;
}
@media (prefers-reduced-motion: reduce) {
  .pk-join { transition: none; }
}
</style>
