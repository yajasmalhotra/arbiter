/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    typedRoutes: true
  },
  transpilePackages: ["ag-grid-community", "ag-grid-react"]
};

export default nextConfig;
