const DEFAULT_IMAGE_TAG = 'latest';

export interface ParsedImageReference {
  name: string;
  tag?: string;
  digest?: string;
}

export function parseImageReference(reference: string): ParsedImageReference {
  const trimmedReference = reference.trim();

  if (!trimmedReference || trimmedReference === '<none>') {
    return { name: trimmedReference };
  }

  const digestSeparatorIndex = trimmedReference.indexOf('@');
  const referenceWithoutDigest =
    digestSeparatorIndex >= 0 ? trimmedReference.slice(0, digestSeparatorIndex) : trimmedReference;
  const digest = digestSeparatorIndex >= 0 ? trimmedReference.slice(digestSeparatorIndex + 1) : undefined;

  const lastSlashIndex = referenceWithoutDigest.lastIndexOf('/');
  const lastColonIndex = referenceWithoutDigest.lastIndexOf(':');
  const hasExplicitTag = lastColonIndex > lastSlashIndex;

  if (!hasExplicitTag) {
    return {
      name: referenceWithoutDigest,
      digest,
    };
  }

  return {
    name: referenceWithoutDigest.slice(0, lastColonIndex),
    tag: referenceWithoutDigest.slice(lastColonIndex + 1),
    digest,
  };
}

export function buildImageReference(image: string, tag?: string) {
  const parsedReference = parseImageReference(image);

  if (!parsedReference.name) {
    return '';
  }

  if (parsedReference.digest) {
    return `${parsedReference.name}@${parsedReference.digest}`;
  }

  const normalizedTag = parsedReference.tag || tag?.trim() || DEFAULT_IMAGE_TAG;
  return `${parsedReference.name}:${normalizedTag}`;
}

export function splitImageReference(reference: string) {
  const parsedReference = parseImageReference(reference);

  if (!parsedReference.name) {
    return {
      image: '',
      tag: DEFAULT_IMAGE_TAG,
    };
  }

  if (parsedReference.digest) {
    return {
      image: `${parsedReference.name}@${parsedReference.digest}`,
      tag: '',
    };
  }

  return {
    image: parsedReference.name,
    tag: parsedReference.tag || DEFAULT_IMAGE_TAG,
  };
}

export { DEFAULT_IMAGE_TAG };
