import { createContext, useContext } from 'react';
import type { ChartProvider } from './format';

/** The chart provider picked in Settings, readable anywhere a chart link is rendered. */
export const ChartProviderContext = createContext<ChartProvider>('basedbot');
export const useChartProvider = () => useContext(ChartProviderContext);
