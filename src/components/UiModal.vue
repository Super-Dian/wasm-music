<script lang="ts" setup>
import { ref, onMounted, onUnmounted } from "vue";

const props = withDefaults(
  defineProps<{
    visible?: boolean;
    title?: string;
    width?: number | string;
    fullscreen?: boolean;
    maskClosable?: boolean;
    escToClose?: boolean;
  }>(),
  {
    visible: false,
    title: "",
    width: 520,
    fullscreen: false,
    maskClosable: true,
    escToClose: true,
  },
);

const emit = defineEmits(["update:visible", "close", "ok", "cancel"]);

// 拖动相关状态
const isDragging = ref(false);
const dragOffset = ref({ x: 0, y: 0 });
const modalPosition = ref({ x: 0, y: 0 });
const modalRef = ref<HTMLDivElement | null>(null);

function close() {
  emit("update:visible", false);
  emit("close");
  emit("cancel");
}

function handleOk() {
  emit("ok");
  close();
}

function handleCancel() {
  emit("cancel");
  close();
}

function handleMaskClick() {
  if (props.maskClosable) {
    close();
  }
}

function handleKeydown(event: KeyboardEvent) {
  if (props.escToClose && event.key === "Escape") {
    close();
  }
}

// 拖动功能
function handleHeaderMouseDown(event: MouseEvent) {
  if (props.fullscreen) return;
  // 只允许左键拖动
  if (event.button !== 0) return;

  const target = event.target as HTMLElement;
  // 排除按钮点击
  if (target.closest(".ui-modal-close")) return;

  isDragging.value = true;
  const modal = modalRef.value;
  if (modal) {
    const rect = modal.getBoundingClientRect();
    dragOffset.value = {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
    modalPosition.value = {
      x: rect.left,
      y: rect.top,
    };
    modal.style.position = "fixed";
    modal.style.left = `${rect.left}px`;
    modal.style.top = `${rect.top}px`;
    modal.style.margin = "0";
  }
  event.preventDefault();
}

function handleMouseMove(event: MouseEvent) {
  if (!isDragging.value) return;

  const modal = modalRef.value;
  if (modal) {
    const newX = event.clientX - dragOffset.value.x;
    const newY = event.clientY - dragOffset.value.y;
    modal.style.left = `${newX}px`;
    modal.style.top = `${newY}px`;
  }
}

function handleMouseUp() {
  isDragging.value = false;
}

onMounted(() => {
  document.addEventListener("mousemove", handleMouseMove);
  document.addEventListener("mouseup", handleMouseUp);
});

onUnmounted(() => {
  document.removeEventListener("mousemove", handleMouseMove);
  document.removeEventListener("mouseup", handleMouseUp);
});
</script>

<template>
  <Teleport to="body">
    <Transition name="ui-modal" appear>
      <div v-if="visible" class="ui-modal-mask" @click="handleMaskClick" @keydown="handleKeydown">
        <div
          ref="modalRef"
          class="ui-modal"
          :class="{ 'ui-modal-fullscreen': fullscreen }"
          :style="{ width: fullscreen ? '100%' : typeof width === 'number' ? `${width}px` : width }"
          @click.stop
        >
          <div
            class="ui-modal-header"
            @mousedown="handleHeaderMouseDown"
            :style="{ cursor: fullscreen ? 'default' : 'move' }"
          >
            <span class="ui-modal-title">{{ title }}</span>
            <button class="ui-modal-close" @click="close">×</button>
          </div>
          <div class="ui-modal-body">
            <slot />
          </div>
          <div v-if="$slots.footer" class="ui-modal-footer">
            <slot name="footer" />
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
/* 模态框打开/关闭动画 */
.ui-modal-enter-active {
  transition: opacity 0.25s ease-out;
}

.ui-modal-enter-active .ui-modal {
  transition:
    transform 0.25s ease-out,
    opacity 0.25s ease-out;
}

.ui-modal-leave-active {
  transition: opacity 0.2s ease-in;
}

.ui-modal-leave-active .ui-modal {
  transition:
    transform 0.2s ease-in,
    opacity 0.2s ease-in;
}

.ui-modal-enter-from,
.ui-modal-leave-to {
  opacity: 0;
}

.ui-modal-enter-from .ui-modal {
  opacity: 0;
  transform: translateY(-20px) scale(0.95);
}

.ui-modal-leave-to .ui-modal {
  opacity: 0;
  transform: translateY(10px) scale(0.98);
}

.ui-modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.ui-modal {
  background: #fff;
  border-radius: 8px;
  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.15);
  max-height: 90vh;
  display: flex;
  flex-direction: column;
  transition: width 0.3s ease;
}

.ui-modal-fullscreen {
  width: 100%;
  height: 100%;
  max-height: 100%;
  border-radius: 0;
}

.ui-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 24px;
  border-bottom: 1px solid #e3e5e7;
  flex-shrink: 0;
}

.ui-modal-title {
  font-size: 16px;
  font-weight: 500;
  color: #18191c;
}

.ui-modal-close {
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: none;
  border: none;
  font-size: 18px;
  color: #666;
  cursor: pointer;
  border-radius: 4px;
  transition: background 0.2s ease;
}

.ui-modal-close:hover {
  background: #f5f5f5;
  color: #18191c;
}

.ui-modal-body {
  padding: 24px;
  overflow-y: auto;
  flex: 1;
}

.ui-modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 16px 24px;
  border-top: 1px solid #e3e5e7;
  flex-shrink: 0;
}
</style>

<style>
/* 深色模式 */
body[arco-theme="dark"] .ui-modal,
body[data-theme="dark"] .ui-modal {
  background: #2a2a2a;
}

body[arco-theme="dark"] .ui-modal-header,
body[data-theme="dark"] .ui-modal-header,
body[arco-theme="dark"] .ui-modal-footer,
body[data-theme="dark"] .ui-modal-footer {
  border-color: #444;
}

body[arco-theme="dark"] .ui-modal-title,
body[data-theme="dark"] .ui-modal-title {
  color: #e0e0e0;
}

body[arco-theme="dark"] .ui-modal-close,
body[data-theme="dark"] .ui-modal-close {
  color: #999;
}

body[arco-theme="dark"] .ui-modal-close:hover,
body[data-theme="dark"] .ui-modal-close:hover {
  background: #3a3a3a;
  color: #e0e0e0;
}
</style>
