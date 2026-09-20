import * as React from 'react';

/**
 * Minimal stand-in for @radix-ui/react-slot: merges the given props (className,
 * event handlers, ref) onto its single child instead of rendering a wrapper
 * element. Enough for this app's `asChild` usage (Button-as-anchor, etc.)
 * without pulling in the extra dependency.
 */
export const Slot = React.forwardRef<HTMLElement, React.HTMLAttributes<HTMLElement> & { children?: React.ReactNode }>(
  ({ children, ...props }, ref) => {
    if (!React.isValidElement(children)) return null;
    const child = children as React.ReactElement<Record<string, unknown>>;
    const childProps = (child.props ?? {}) as Record<string, unknown>;
    return React.cloneElement(child, {
      ...props,
      ...childProps,
      className: cx(props.className, childProps.className as string | undefined),
      style: { ...(props.style as object | undefined), ...(childProps.style as object | undefined) },
      ref,
    } as Record<string, unknown>);
  },
);
Slot.displayName = 'Slot';

function cx(...parts: (string | undefined)[]) {
  return parts.filter(Boolean).join(' ');
}
