/**
 * Mental Deck - CardBack Component
 * Custom petrol blue playing card back with interlocking geometric rings pattern and count badge.
 */

import React from 'react';

interface CardBackProps {
  count?: number;
  size?: 'sm' | 'md' | 'lg' | 'stack';
  className?: string;
  onClick?: () => void;
  showBadge?: boolean;
}

export const CardBack: React.FC<CardBackProps> = ({
  count,
  size = 'md',
  className = '',
  onClick,
  showBadge = true,
}) => {
  const sizeClasses = {
    sm: 'w-12 h-16 rounded-lg',
    md: 'w-16 h-22 rounded-xl',
    lg: 'w-20 h-28 rounded-xl',
    stack: 'w-14 h-20 sm:w-16 sm:h-22 rounded-xl',
  }[size];

  return (
    <div
      onClick={onClick}
      className={`relative select-none ${sizeClasses} bg-[#244653] border border-[#355D6C] shadow-md flex items-center justify-center overflow-hidden transition-transform duration-150 ${className}`}
      style={{
        boxShadow: '0 3px 8px rgba(23, 43, 51, 0.25), inset 0 0 0 1px rgba(255, 255, 255, 0.1)',
      }}
    >
      {/* Inner thin border */}
      <div className="absolute inset-1 rounded-md border border-[#487384]/40 pointer-events-none" />

      {/* Interlocking geometric gold/cream rings (SVG pattern) */}
      <svg
        viewBox="0 0 64 88"
        className="w-4/5 h-4/5 opacity-80 pointer-events-none"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        {/* Background diamond mesh */}
        <path
          d="M32 10 L54 44 L32 78 L10 44 Z"
          stroke="#729CAD"
          strokeWidth="0.8"
          strokeDasharray="2 2"
          opacity="0.4"
        />
        {/* Intersecting central rings */}
        <circle cx="32" cy="34" r="14" stroke="#E6CE9F" strokeWidth="1.2" opacity="0.85" />
        <circle cx="32" cy="54" r="14" stroke="#E6CE9F" strokeWidth="1.2" opacity="0.85" />
        <circle cx="32" cy="44" r="9" stroke="#9BBECB" strokeWidth="0.9" opacity="0.7" />
        <ellipse cx="32" cy="44" rx="18" ry="8" stroke="#E6CE9F" strokeWidth="1" opacity="0.75" />
        {/* Center pivot dot */}
        <circle cx="32" cy="44" r="2" fill="#E6CE9F" />
      </svg>

      {/* Bottom right circular count badge */}
      {showBadge && count !== undefined && (
        <div
          className="absolute -bottom-1 -right-1 w-6 h-6 rounded-full bg-white text-[#171B1E] font-bold text-xs flex items-center justify-center shadow-md border border-slate-200"
          style={{ zIndex: 10 }}
        >
          {count}
        </div>
      )}
    </div>
  );
};
