import type IForkTsCheckerWebpackPlugin from 'fork-ts-checker-webpack-plugin';

const ForkTsCheckerWebpackPlugin: typeof IForkTsCheckerWebpackPlugin = require('fork-ts-checker-webpack-plugin');
const { DefinePlugin, BannerPlugin } = require('webpack');

export const plugins = [
  new ForkTsCheckerWebpackPlugin({
    logger: 'webpack-infrastructure',
  }),
];

// Renderer plugins:
// The @vercel/webpack-asset-relocator-loader injects `__dirname + "/native_modules/"` into the
// webpack RUNTIME chunk (not module source), so DefinePlugin alone can't shim it. BannerPlugin
// prepends `var __dirname = "";` to the bundle, executing before any runtime code. The renderer
// runs with contextIsolation:true + nodeIntegration:false, so no native modules load here anyway.
export const rendererPlugins = [
  ...plugins,
  new DefinePlugin({
    __dirname: JSON.stringify(''),
  }),
  new BannerPlugin({
    banner: 'var __dirname = "";',
    raw: true,
    entryOnly: false,
  }),
];
