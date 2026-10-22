import type { ButtonHTMLAttributes } from 'react';

export function PreviewButton({ label, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return <button type="button" className={`media-preview-button ${className}`} aria-label={label} title={label} {...props} />;
}
