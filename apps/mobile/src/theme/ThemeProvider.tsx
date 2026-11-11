import { type Theme, darkTheme } from '@pace/design-system';
import { createContext, type ReactNode, useContext } from 'react';

const ThemeContext = createContext<Theme>(darkTheme);

/** Dark is the shipped experience; light tokens exist for a future toggle. */
export function ThemeProvider({
  children,
  theme = darkTheme,
}: {
  children: ReactNode;
  theme?: Theme;
}) {
  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  return useContext(ThemeContext);
}
