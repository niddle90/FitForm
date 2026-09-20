import * as React from 'react';
import { Slot } from './slot';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-semibold transition-[transform,box-shadow] duration-100 disabled:pointer-events-none disabled:opacity-40 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          'border-2 border-border bg-primary text-primary-foreground shadow-hard-sm hover:brightness-105 active:translate-x-[2px] active:translate-y-[2px] active:shadow-none',
        destructive:
          'border-2 border-border bg-destructive text-destructive-foreground shadow-hard-sm hover:brightness-105 active:translate-x-[2px] active:translate-y-[2px] active:shadow-none',
        outline:
          'border-2 border-border bg-background text-foreground shadow-hard-sm hover:bg-accent active:translate-x-[2px] active:translate-y-[2px] active:shadow-none',
        secondary:
          'border-2 border-border bg-secondary text-secondary-foreground shadow-hard-sm hover:bg-secondary/80 active:translate-x-[2px] active:translate-y-[2px] active:shadow-none',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-9 px-4 py-2',
        sm: 'h-8 rounded-md px-3 text-xs',
        lg: 'h-11 rounded-lg px-6 text-[15px]',
        icon: 'h-9 w-9 shrink-0',
        'icon-sm': 'h-7 w-7 shrink-0',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />;
  },
);
Button.displayName = 'Button';

export { Button, buttonVariants };
