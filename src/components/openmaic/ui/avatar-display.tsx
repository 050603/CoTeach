'use client';

import { cn } from '@openmaic/lib/utils';
import { ResilientImage } from '@/components/resilient-image';

interface AvatarDisplayProps {
  readonly src: string;
  readonly alt?: string;
  readonly className?: string;
}

export function AvatarDisplay({ src, alt, className }: AvatarDisplayProps) {
  const isUrl = /^(https?:|data:|blob:|\/)/i.test(src);

  if (isUrl) {
    return (
      <ResilientImage
        src={src}
        alt={alt || ''}
        width={64}
        height={64}
        unoptimized
        fallback={<span className="flex h-full w-full items-center justify-center text-current">{alt?.trim().slice(0, 1) || '人'}</span>}
        className={cn('w-full h-full object-cover', className)}
      />
    );
  }

  return (
    <span
      role="img"
      aria-label={alt || ''}
      className={cn('flex items-center justify-center w-full h-full select-none', className)}
    >
      {src}
    </span>
  );
}
