export function getVertexSource() {
    return `
    attribute vec2 a_pos;
    uniform mat4 u_matrix;
    void main() {
        gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0);
    }
    `;
}

export function getFragmentSource(numLatSteps: number, gridSizeX: number, gridSizeY: number) {
    return `
    precision mediump float;

    uniform vec2 u_drawingBufferSize;
    uniform vec2 u_viewportBoundsMercatorMin;
    uniform vec2 u_viewportBoundsMercatorSize;

    uniform vec2 u_dataBoundsMercatorMin;
    uniform float u_lngMercatorStep;
    uniform float u_latMercatorSteps[${numLatSteps}];
    
    uniform float u_opacity;
    uniform sampler2D u_gridTexture;

    void main() {

        vec2 fragCoordNormalized = gl_FragCoord.xy / u_drawingBufferSize;
        vec2 fragCoordMercator = u_viewportBoundsMercatorMin + u_viewportBoundsMercatorSize * vec2(fragCoordNormalized.x, 1.0 - fragCoordNormalized.y);

        // Calculate the longitude index
        float lngIndex = floor((fragCoordMercator.x - u_dataBoundsMercatorMin.x) / u_lngMercatorStep);

        // Find the latitude index
        int latIndexInt = 0;
        for (int i = 0; i < ${numLatSteps}; i++) {
            if (fragCoordMercator.y >= u_latMercatorSteps[i]) {
                latIndexInt = i;
            } else {
                break;
            }
        }
        
        float latIndex = float(latIndexInt);

        // Look up color
        vec2 gridSize = vec2(${gridSizeX}, ${gridSizeY});
        vec2 texCoords = vec2(lngIndex / gridSize.x, latIndex / gridSize.y);
        vec4 color = texture2D(u_gridTexture, texCoords).rgba;

        float opacity = u_opacity * color.a;
        vec3 premultipliedColor = color.xyz * opacity;
        gl_FragColor = vec4(premultipliedColor, opacity);
    }
    `;
}