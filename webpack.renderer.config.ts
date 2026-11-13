import type { Configuration } from 'webpack';

import { rules } from './webpack.rules';
import { rendererPlugins } from './webpack.plugins';

rules.push({
  test: /\.css$/,
  use: [{ loader: 'style-loader' }, { loader: 'css-loader' }],
});

rules.push({
  test: /\.ttf$/,
  type: 'asset/resource',
});

export const rendererConfig: Configuration = {
  // Use 'web' target since we use contextIsolation + no nodeIntegration.
  // This prevents Monaco's AMD loader from conflicting with Node.js module globals.
  target: 'web',
  module: {
    rules,
  },
  plugins: rendererPlugins,
  resolve: {
    extensions: ['.js', '.ts', '.jsx', '.tsx', '.css'],
    // Required for pure-ESM packages like @milkdown/* whose package.json
    // exports map only declares the "import" condition.
    conditionNames: ['import', 'module', 'webpack', 'development', 'browser', 'require', 'default'],
  },
};
