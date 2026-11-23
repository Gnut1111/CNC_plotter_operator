// Directions are clockwise in image coordinates, with Y increasing downward.
const neighbors = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
const bitCounts = Uint8Array.from({ length: 256 }, (_, mask) => {
  let count = 0;
  for (; mask; mask &= mask - 1) count += 1;
  return count;
});

function traceSkeleton({ binary, width, height }) {
  const links = new Uint8Array(binary.length);
  const visited = new Uint8Array(binary.length);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      if (!binary[i]) continue;

      for (let direction = 0; direction < 4; direction += 1) {
        const [dx, dy] = neighbors[direction];
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height || !binary[ny * width + nx]) continue;
        // A diagonal is only needed where there is no two-edge orthogonal route.
        if (dx && dy && (binary[y * width + nx] || binary[ny * width + x])) continue;
        links[i] |= 1 << direction;
        links[ny * width + nx] |= 1 << (direction + 4);
      }
    }
  }

  const paths = [];
  const point = (i) => ({ x: i % width + 0.5, y: Math.floor(i / width) + 0.5 });

  function follow(start, direction) {
    const points = [point(start)];
    let current = start;
    while (direction !== -1) {
      const [dx, dy] = neighbors[direction];
      const next = current + dy * width + dx;
      visited[current] |= 1 << direction;
      visited[next] |= 1 << ((direction + 4) % 8);
      current = next;
      points.push(point(current));
      if (current === start || bitCounts[links[current]] !== 2) break;
      direction = firstDirection(links[current] & ~visited[current]);
    }
    return {
      points,
      closed: start === current,
      connectsJunctions: bitCounts[links[start]] > 2 && bitCounts[links[current]] > 2,
    };
  }

  for (const cycles of [false, true]) {
    for (let i = 0; i < links.length; i += 1) {
      if ((bitCounts[links[i]] === 2) !== cycles) continue;
      let direction;
      while ((direction = firstDirection(links[i] & ~visited[i])) !== -1) {
        paths.push(follow(i, direction));
      }
    }
  }
  return paths;
}

function firstDirection(mask) {
  return mask ? 31 - Math.clz32(mask & -mask) : -1;
}

module.exports = { traceSkeleton };
