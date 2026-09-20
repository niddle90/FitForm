import * as React from 'react';
import { cn } from '@/lib/utils';

const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          'flex h-9 w-full rounded-lg border-2 border-input bg-background px-3 py-1.5 text-sm font-medium shadow-hard-sm transition-[transform,box-shadow]',
          'placeholder:text-muted-foreground placeholder:font-normal',
          'focus-visible:outline-none focus-visible:translate-x-[1px] focus-visible:translate-y-[1px] focus-visible:shadow-none',
          'disabled:cursor-not-allowed disabled:opacity-50',
          '[appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none',
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Input.displayName = 'Input';

export { Input };
