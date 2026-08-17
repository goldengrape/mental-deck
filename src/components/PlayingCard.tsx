/**
 * Mental Deck - Playing Card Component
 * Tactile, ivory paper card rendering with crisp suits, selection elevation, and smooth flip support.
 */

import React from 'react';
import { motion } from 'motion/react';
import { CardInstance } from '../types/contracts';
import { CardBack } from './CardBack';

interface PlayingCardProps {
  cardInstance?: CardInstance;
  isFaceUp: boolean;
  isSelected?: boolean;
  isPairCandidate?: boolean;
  isPublicKnown?: boolean;
  onClick?: () => void;
  disabled?: boolean;
  size?: 'sm' | 'md' | 'lg';
  count?: number;
}

export const PlayingCard: React.FC<PlayingCardProps> = ({
  cardInstance,
  isFaceUp,
  isSelected = false,
  isPairCandidate = false,
  isPublicKnown = false,
  onClick,
  disabled = false,
  size = 'md',
  count,
}) => {
  if (!isFaceUp || !cardInstance) {
    return (
      <motion.div
        whileHover={!disabled ? { y: -3 } : {}}
        onClick={!disabled ? onClick : undefined}
        className={`cursor-pointer ${disabled ? 'opacity-60 cursor-not-allowed' : ''}`}
      >
        <CardBack count={count} size={size} />
      </motion.div>
    );
  }

  const isRed = cardInstance.suit === '♥' || cardInstance.suit === '♦';
  const isOldMaid = cardInstance.metadata?.is_old_maid === true || cardInstance.symbol === 'Q♠';

  const sizeClasses = {
    sm: 'w-11 h-16 text-xs p-1 rounded-lg',
    md: 'w-16 h-24 sm:w-18 sm:h-26 text-sm p-1.5 rounded-xl',
    lg: 'w-20 h-30 sm:w-22 sm:h-32 text-base p-2 rounded-xl',
  }[size];

  const suitSymbol = cardInstance.suit && cardInstance.suit !== 'none' ? cardInstance.suit : '♠';
  const rankSymbol = cardInstance.rank || cardInstance.symbol.replace(/[♠♥♦♣]/g, '');

  return (
    <motion.div
      id={`card-${cardInstance.card_instance_id}`}
      whileHover={!disabled ? { y: isSelected ? -8 : -4 } : {}}
      whileTap={!disabled ? { scale: 0.98 } : {}}
      animate={{ y: isSelected ? -8 : 0 }}
      transition={{ duration: 0.16, ease: 'easeOut' }}
      onClick={!disabled ? onClick : undefined}
      className={`relative select-none cursor-pointer ${sizeClasses} bg-[#FFFDF8] border transition-all duration-150 flex flex-col justify-between overflow-hidden ${
        isSelected
          ? 'border-2 border-[#205545] card-paper-selected'
          : isPairCandidate
          ? 'border border-[#26866F] shadow-md'
          : 'border-[#E0DCD3] card-paper'
      } ${disabled ? 'opacity-60 cursor-not-allowed' : ''}`}
    >
      {/* Public known indicator banner if card was disclosed on failed pair */}
      {isPublicKnown && (
        <div className="absolute top-0 right-0 bg-amber-500/15 text-amber-800 text-[8px] font-bold px-1 rounded-bl">
          公开
        </div>
      )}

      {/* Top Left: Rank & Suit */}
      <div className="flex flex-col items-start leading-none pointer-events-none">
        <span
          className={`font-bold font-sans text-xs sm:text-sm tracking-tighter ${
            isRed ? 'text-[#C83737]' : 'text-[#171B1E]'
          }`}
        >
          {rankSymbol}
        </span>
        <span
          className={`text-[10px] sm:text-xs leading-none mt-0.5 ${
            isRed ? 'text-[#C83737]' : 'text-[#171B1E]'
          }`}
        >
          {suitSymbol}
        </span>
      </div>

      {/* Center Suit Graphic */}
      <div className="self-center my-auto pointer-events-none flex items-center justify-center">
        {isOldMaid ? (
          <div className="flex flex-col items-center">
            <span className="text-xl sm:text-2xl text-[#171B1E] leading-none">♠</span>
            <span className="text-[7px] sm:text-[8px] font-bold text-[#8C3A82] tracking-wider uppercase mt-0.5">
              Old Maid
            </span>
          </div>
        ) : (
          <span
            className={`text-xl sm:text-2xl leading-none select-none ${
              isRed ? 'text-[#C83737]' : 'text-[#171B1E]'
            }`}
          >
            {suitSymbol}
          </span>
        )}
      </div>

      {/* Bottom Right: Inverted Rank & Suit */}
      <div className="flex flex-col items-end leading-none rotate-180 pointer-events-none self-end">
        <span
          className={`font-bold font-sans text-xs sm:text-sm tracking-tighter ${
            isRed ? 'text-[#C83737]' : 'text-[#171B1E]'
          }`}
        >
          {rankSymbol}
        </span>
        <span
          className={`text-[10px] sm:text-xs leading-none mt-0.5 ${
            isRed ? 'text-[#C83737]' : 'text-[#171B1E]'
          }`}
        >
          {suitSymbol}
        </span>
      </div>
    </motion.div>
  );
};
