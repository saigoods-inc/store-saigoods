function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function permutations(values) {
  const [a, b, c] = values;
  return [
    [a, b, c], [a, c, b], [b, a, c],
    [b, c, a], [c, a, b], [c, b, a],
  ];
}

export function axisAlignedBoxCapacity(container, item) {
  const containerDimensions = [positive(container?.length), positive(container?.width), positive(container?.height)];
  const itemDimensions = [positive(item?.length), positive(item?.width), positive(item?.height)];
  if (containerDimensions.some((value) => !value) || itemDimensions.some((value) => !value)) return 0;
  return Math.max(
    ...permutations(itemDimensions).map((orientation) =>
      containerDimensions.reduce(
        (capacity, dimension, index) => capacity * Math.floor((dimension + 0.0001) / orientation[index]),
        1,
      ),
    ),
  );
}

export function configuredCartonCapacity(carton) {
  const geometricCapacity = axisAlignedBoxCapacity(carton?.inner, carton?.maxRetailBox || carton?.inner);
  const configured = Math.max(0, Math.floor(Number(carton?.maxRetailBoxes) || 0));
  return Math.min(configured, geometricCapacity);
}

export function assertCartonCapacityIsPhysical(carton) {
  const configured = Math.max(0, Math.floor(Number(carton?.maxRetailBoxes) || 0));
  const geometric = axisAlignedBoxCapacity(carton?.inner, carton?.maxRetailBox || carton?.inner);
  if (configured > geometric) {
    const error = new Error(
      `Carton ${carton?.id || "profile"} is configured for ${configured} retail boxes, but its inner dimensions fit at most ${geometric}.`,
    );
    error.statusCode = 400;
    throw error;
  }
  return geometric;
}
