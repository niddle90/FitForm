import { Switch as UiSwitch } from './ui/switch';

interface Props {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
}

export function Switch({ checked, onChange, label }: Props) {
  return (
    <UiSwitch
      checked={checked}
      onCheckedChange={onChange}
      aria-label={label}
      onClick={(e) => e.stopPropagation()}
    />
  );
}
