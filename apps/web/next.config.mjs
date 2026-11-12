/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@autonex/shared'],
  images: {
    unoptimized: true,
  },
};

export default nextConfig;

