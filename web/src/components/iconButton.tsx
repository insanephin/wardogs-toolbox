import type { ButtonHTMLAttributes } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { config } from '@fortawesome/fontawesome-svg-core';
import type { IconDefinition } from '@fortawesome/fontawesome-svg-core';
import '@fortawesome/fontawesome-svg-core/styles.css';

config.autoAddCss = false;

export { FontAwesomeIcon as Icon };

export function IconButton({ icon, label, className = '', ...rest }: { icon: IconDefinition; label: string } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className={`btn btn-sm btn-icon ${className}`.trim()} aria-label={label} title={label} {...rest}>
      <FontAwesomeIcon icon={icon} />
    </button>
  );
}
