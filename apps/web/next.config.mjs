/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: [
    '@autonex/shared',
    '@autonex/types',
    '@autonex/permissions',
    '@autonex/validation',
    '@autonex/ui',
  ],
  images: {
    unoptimized: true,
  },
};

export default nextConfig;

