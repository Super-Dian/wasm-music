<script lang="ts" setup>
const props = withDefaults(
  defineProps<{
    modelValue?: string;
    placeholder?: string;
    disabled?: boolean;
    readonly?: boolean;
    rows?: number;
    maxLength?: number;
    showWordLimit?: boolean;
  }>(),
  {
    modelValue: "",
    placeholder: "",
    disabled: false,
    readonly: false,
    rows: 3,
    maxLength: undefined,
    showWordLimit: false,
  },
);

defineEmits(["update:modelValue", "input", "change", "focus", "blur", "paste"]);

const charCount = computed(() => (props.modelValue || "").length);
</script>

<template>
  <div class="ui-textarea-wrapper">
    <textarea
      :class="[
        'ui-textarea',
        disabled && 'ui-textarea-disabled',
        readonly && 'ui-textarea-readonly',
      ]"
      :value="modelValue"
      :placeholder="placeholder"
      :disabled="disabled"
      :readonly="readonly"
      :rows="rows"
      :maxlength="maxLength"
      @input="
        $emit('update:modelValue', ($event.target as HTMLTextAreaElement).value);
        $emit('input', $event);
      "
      @change="$emit('change', $event)"
      @focus="$emit('focus', $event)"
      @blur="$emit('blur', $event)"
      @paste="$emit('paste', $event)"
    ></textarea>
    <span v-if="showWordLimit" class="ui-textarea-word-limit">
      {{ charCount }}{{ maxLength ? `/${maxLength}` : "" }}
    </span>
  </div>
</template>

<style scoped>
.ui-textarea-wrapper {
  position: relative;
  width: 100%;
  display: flex;
  flex-direction: column;
}

.ui-textarea {
  width: 100%;
  padding: 8px 12px;
  font-size: 14px;
  line-height: 1.5715;
  color: #18191c;
  background: #fff;
  border: 1px solid #c9ccd0;
  border-radius: 6px;
  outline: none;
  resize: vertical;
  transition: all 0.2s ease;
  box-sizing: border-box;
  font-family: inherit;
  flex: 1;
}

.ui-textarea:focus {
  border-color: #00aeec;
  box-shadow: 0 0 0 2px rgba(0, 174, 236, 0.15);
}

.ui-textarea::placeholder {
  color: #c9ccd0;
}

/* States */
.ui-textarea-disabled {
  background: #f5f5f5;
  border-color: #e3e5e7;
  color: #c9ccd0;
  cursor: not-allowed;
}

.ui-textarea-readonly {
  background: #f5f5f5;
}

/* Word limit */
.ui-textarea-word-limit {
  position: absolute;
  bottom: 8px;
  right: 12px;
  font-size: 12px;
  color: #c9ccd0;
}
</style>

<style>
/* 深色模式 */
body[arco-theme="dark"] .ui-textarea,
body[data-theme="dark"] .ui-textarea {
  color: #e0e0e0;
  background: #2a2a2a;
  border-color: #555;
}

body[arco-theme="dark"] .ui-textarea::placeholder,
body[data-theme="dark"] .ui-textarea::placeholder {
  color: #666;
}

body[arco-theme="dark"] .ui-textarea:focus,
body[data-theme="dark"] .ui-textarea:focus {
  border-color: #00aeec;
}

body[arco-theme="dark"] .ui-textarea-disabled,
body[data-theme="dark"] .ui-textarea-disabled {
  background: #1f1f1f;
  border-color: #444;
  color: #666;
}

body[arco-theme="dark"] .ui-textarea-readonly,
body[data-theme="dark"] .ui-textarea-readonly {
  background: #1f1f1f;
}

body[arco-theme="dark"] .ui-textarea-word-limit,
body[data-theme="dark"] .ui-textarea-word-limit {
  color: #666;
}
</style>
