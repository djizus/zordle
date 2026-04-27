type DojoManifest = {
  world?: {
    address?: string;
  };
  contracts?: Array<{
    address: string;
    tag: string;
  }>;
};

const manifests = import.meta.glob<DojoManifest>("../../manifest_*.json", {
  eager: true,
  import: "default",
});

const manifestByName = (name: string): DojoManifest | undefined =>
  manifests[`../../manifest_${name}.json`];

export const contractAddressFromManifest = (
  manifestName: string,
  namespace: string,
  contractName: string,
): string | undefined => {
  const manifest = manifestByName(manifestName);
  const tag = `${namespace}-${contractName}`;
  return manifest?.contracts?.find((contract) => contract.tag === tag)?.address;
};

export const worldAddressFromManifest = (manifestName: string): string | undefined =>
  manifestByName(manifestName)?.world?.address;
