# Demo
Custom layer for mapbox-gl that efficiently displays large sets of world space data as a grid of colors.
[View demo](https://ptnoavailability.z1.web.core.windows.net)

![alt text](./images/demo.png)

# Features
* Display data in world coordinates (latitide and longitude)
* Processor and memory efficient rendering with WebGL

# Installation
`npm install mapbox-gl-choropleth-grid-layer`

# Usage (TypeScript)
> IMPORTANT  
> This layer only supports the Mercator projection

```typescript
// Create an instance of the layer
const gridLayer = createLayer({
    dataGrid: [
        [1, 1, 2]
        [1, 2, 3]
        [2, 3, 3]
    ],
    getColor: x => {
        switch(x) {
            case 1: return [255, 0, 0, 255];
            case 2: return [0, 255, 0, 255];
            case 3: return [0, 0, 255, 255];
            default: return [0, 0, 0, 0];
        }
    },
    stepSize: {
        lat: 0.1,
        lng: 0.1
    },
    offset: {
        lat: 59.78,
        lng: 10.6
    },
    opacity: 0.25
});

// Add the layer to the map
map.addLayer(gridLayer);
```