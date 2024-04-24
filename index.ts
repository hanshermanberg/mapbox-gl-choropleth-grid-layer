import mapboxgl, { CustomLayerInterface, MercatorCoordinate } from "mapbox-gl";

interface IChoroplethGridLayerData<T> {
    dataArray: T[][],
    getColor: (d: T) => [number, number, number, number];
    stepSize: { lng: number, lat: number };
    offset: { lng: number, lat: number };
}

function verifyData<T>({ dataArray, stepSize, offset }: IChoroplethGridLayerData<T>) {
    if(offset.lat < -90 || offset.lat > 90) { 
        throw new Error("Offset latitude must be between -90 and 90."); 
    }
    if(offset.lng < -180 || offset.lat > 180) { 
        throw new Error("Offset longitude must be between -180 and 180."); 
    }
    if(stepSize.lat <= 0 || stepSize.lat > 180) { 
        throw new Error("Step size latitude must be greater than 0 and less than or equal to 180."); 
    }
    if(stepSize.lng <= 0 || stepSize.lng > 360) { 
        throw new Error("Step size must be greater than 0 and less than or equal to 360."); 
    }
    if(!dataArray.every(row => row.length === dataArray[0]?.length)) { 
        throw new Error("Data array dimensions are not uniform."); 
    }
}

interface IGeoColorGridOptions {
    opacity: number;
}

function verifyOptions({ opacity }: IGeoColorGridOptions) {
    if(opacity < 0 || opacity > 1) {
        throw new Error("Opacity must be greater than or equal to 0 and less than or equal to 1.");
    }
}

export function createLayer<T>(data: IChoroplethGridLayerData<T>, options: IGeoColorGridOptions): CustomLayerInterface {
    verifyData(data);
    verifyOptions(options);

    // Get colors for each data point in the grid
    const colorGrid = data.dataArray.map(row => row.map(p => {
        const color = data.getColor(p);
        if(!color.every(x => x >= 0 && x <= 255)) {
            throw new Error("Color values must be between 0 and 255.");
        }
        return color;
    }));

    if(colorGrid[0] === undefined) {
        throw new Error("Data row is undefined.");
    }
    const gridSize = {
        x: colorGrid.length,
        y: colorGrid[0].length
    };

    const dataBounds = {
        sw: {
            lat: data.offset.lat,
            lng: data.offset.lng
        },
        ne: {
            lat: data.offset.lat + gridSize.y * data.stepSize.lat,
            lng: data.offset.lng + gridSize.x * data.stepSize.lng
        }
    };

    // Calculate bounds of dataset in Mercator space
    const dataBoundsMercator = {
        bottomLeft: MercatorCoordinate.fromLngLat(dataBounds.sw),
        topLeft: MercatorCoordinate.fromLngLat({ lng: dataBounds.sw.lng, lat: dataBounds.ne.lat }),
        bottomRight: MercatorCoordinate.fromLngLat({ lng: dataBounds.ne.lng, lat: dataBounds.sw.lat }),
        topRight: MercatorCoordinate.fromLngLat(dataBounds.ne),
        size: { x: 0, y: 0 }
    };
    dataBoundsMercator.size = {
        x: dataBoundsMercator.bottomRight.x - dataBoundsMercator.topLeft.x,
        y: dataBoundsMercator.bottomRight.y - dataBoundsMercator.topLeft.y
    };

    // Latitude doesn"t scale linearly, so we need to calcuate
    // Mercator space y-coordinates for each latitude step in the dataset
    const latStepsMercator: number[] = [];
    for(let lat = dataBounds.ne.lat; lat >= dataBounds.sw.lat; lat -= data.stepSize.lat) {
        const mercatorCoordinates = MercatorCoordinate.fromLngLat({ lng: 0, lat });
        latStepsMercator.push(mercatorCoordinates.y);
    }

    // Longitude scales linearly, so we only need to 
    // calculate a single step in Mercator space
    const lngStepMercator = (() => {
        const a = MercatorCoordinate.fromLngLat(dataBounds.sw);
        const b = MercatorCoordinate.fromLngLat({ lng: dataBounds.sw.lng + data.stepSize.lng, lat: dataBounds.sw.lat });
        return b.x - a.x;
    })();

    const vertexSource = `
    attribute vec2 a_pos;
    uniform mat4 u_matrix;
    void main() {
        gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0);
    }
    `;

    const fragmentSource = `
    precision mediump float;

    uniform vec2 u_drawingBufferSize;
    uniform vec2 u_viewportBoundsMercatorMin;
    uniform vec2 u_viewportBoundsMercatorSize;

    uniform vec2 u_dataBoundsMercatorMin;
    uniform float u_lngMercatorStep;
    uniform float u_latMercatorSteps[${latStepsMercator.length}];
    
    uniform float u_opacity;
    uniform sampler2D u_gridTexture;

    void main() {

        vec2 fragCoordNormalized = gl_FragCoord.xy / u_drawingBufferSize;
        vec2 fragCoordMercator = u_viewportBoundsMercatorMin + u_viewportBoundsMercatorSize * vec2(fragCoordNormalized.x, 1.0 - fragCoordNormalized.y);

        // Calculate the longitude index
        float lngIndex = floor((fragCoordMercator.x - u_dataBoundsMercatorMin.x) / u_lngMercatorStep);

        // Find the latitude index
        int latIndexInt = 0;
        for (int i = 0; i < ${latStepsMercator.length}; i++) {
            if (fragCoordMercator.y >= u_latMercatorSteps[i]) {
                latIndexInt = i;
            } else {
                break;
            }
        }
        
        float latIndex = float(latIndexInt);

        // Look up color
        vec2 gridSize = vec2(${gridSize.x}, ${gridSize.y});
        vec2 texCoords = vec2(lngIndex / gridSize.x, latIndex / gridSize.y);
        vec4 color = texture2D(u_gridTexture, texCoords).rgba;

        float opacity = u_opacity * color.a;
        vec3 premultipliedColor = color.xyz * opacity;
        gl_FragColor = vec4(premultipliedColor, opacity);
    }
    `;

    let g_map: mapboxgl.Map;
    let program: WebGLProgram;
    let bVertex: WebGLBuffer;
    let tGrid: WebGLTexture;

    return {
        id: "grid",
        type: "custom",
        onAdd: function (map: mapboxgl.Map, gl: WebGLRenderingContext) {

            if(map.getProjection().name !== "mercator") {
                throw new Error("Choropleth grid layer is only supported for mercator projection.");
            }

            g_map = map;

            const vertexShader = createVertexShader(gl, vertexSource);
            const fragmentShader = createFragmentShader(gl, fragmentSource);
            program = createProgram(gl, vertexShader, fragmentShader);

            // Create and initialize a WebGLBuffer to store vertex data
            // Triangle strip square covering data bounds
            bVertex = createFloat32Buffer(gl, [
                dataBoundsMercator.bottomLeft.x, dataBoundsMercator.bottomLeft.y,
                dataBoundsMercator.topLeft.x, dataBoundsMercator.topLeft.y,
                dataBoundsMercator.bottomRight.x, dataBoundsMercator.bottomRight.y,
                dataBoundsMercator.topRight.x, dataBoundsMercator.topRight.y
            ]);

            // Prepare grid texture color data
            const transposed: [number, number, number, number][][] = [];
            for (let i = 0; i < gridSize.x; i++) {
                const row: [number, number, number, number][] = [];
                for (let j = 0; j < gridSize.y; j++) {
                    const gridJ = colorGrid[j];
                    if(gridJ === undefined) {
                        throw new Error("Row in color matrix was null."); 
                    }
                    const gridJI = gridJ[i];
                    if(gridJI === undefined) {
                        throw new Error("Cell in color matrix was null."); 
                    }
                    row.push(gridJI);
                }
                transposed.push(row);
            }
            transposed.reverse();
            const gridData = new Uint8Array(transposed.flat().flat());

            // Create texture with grid color data
            tGrid = gl.createTexture() as WebGLTexture;
            gl.bindTexture(gl.TEXTURE_2D, tGrid);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gridSize.x, gridSize.y, 0, gl.RGBA, gl.UNSIGNED_BYTE, gridData);
        },
        render: function (gl: WebGLRenderingContext, matrix: Iterable<number>) {

            gl.useProgram(program);

            // Calculate viewport bounds in Mercator space
            const viewportBoundsLngLat = g_map.getBounds();
            const viewportBoundsMercatorSW = MercatorCoordinate.fromLngLat(viewportBoundsLngLat._sw);
            const viewportBoundsMercatorNE = MercatorCoordinate.fromLngLat(viewportBoundsLngLat._ne);
            const viewportBoundsMercatorSize = {
                x: viewportBoundsMercatorNE.x - viewportBoundsMercatorSW.x,
                y: viewportBoundsMercatorSW.y - viewportBoundsMercatorNE.y
            };

            // Upload uniforms
            gl.uniformMatrix4fv(gl.getUniformLocation(program, "u_matrix"), false, matrix);
            gl.uniform2f(gl.getUniformLocation(program, "u_drawingBufferSize"), gl.drawingBufferWidth, gl.drawingBufferHeight);
            gl.uniform2f(gl.getUniformLocation(program, "u_viewportBoundsMercatorMin"), viewportBoundsMercatorSW.x, viewportBoundsMercatorNE.y);
            gl.uniform2f(gl.getUniformLocation(program, "u_viewportBoundsMercatorSize"), viewportBoundsMercatorSize.x, viewportBoundsMercatorSize.y);
            gl.uniform2f(gl.getUniformLocation(program, "u_dataBoundsMercatorMin"), dataBoundsMercator.topLeft.x, dataBoundsMercator.topLeft.y);
            gl.uniform1f(gl.getUniformLocation(program, "u_lngMercatorStep"), lngStepMercator);
            gl.uniform1fv(gl.getUniformLocation(program, "u_latMercatorSteps"), new Float32Array(latStepsMercator));
            gl.uniform1f(gl.getUniformLocation(program, "u_opacity"), options.opacity);

            // Upload grid color texture
            gl.uniform1i(gl.getUniformLocation(program, "u_paletteIndexTexture"), 0);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, tGrid);

            // Upload vertex data
            gl.bindBuffer(gl.ARRAY_BUFFER, bVertex);
            const aVertex = gl.getAttribLocation(program, "a_pos");
            gl.enableVertexAttribArray(aVertex);
            gl.vertexAttribPointer(aVertex, 2, gl.FLOAT, false, 0, 0);

            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        }
    };
}

function createVertexShader(gl: WebGLRenderingContext, vertexSource: string) {
    const vertexShader = gl.createShader(gl.VERTEX_SHADER);
    if(vertexShader === null) {
        throw new Error("Error creating WebGL vertex shader.");
    }
    gl.shaderSource(vertexShader, vertexSource);
    gl.compileShader(vertexShader);

    // Check for compilation errors
    if (!gl.getShaderParameter(vertexShader, gl.COMPILE_STATUS)) {
        console.error("Vertex shader compilation error:", gl.getShaderInfoLog(vertexShader));
    }

    return vertexShader;
}

function createFragmentShader(gl: WebGLRenderingContext, fragmentSource: string) {
    const fragmentShader = gl.createShader(gl.FRAGMENT_SHADER);
    if(fragmentShader === null) {
        throw new Error("Error creating WebGL fragment shader.");
    }
    gl.shaderSource(fragmentShader, fragmentSource);
    gl.compileShader(fragmentShader);

    // Check for compilation errors
    if (!gl.getShaderParameter(fragmentShader, gl.COMPILE_STATUS)) {
        console.error("Fragment shader compilation error:", gl.getShaderInfoLog(fragmentShader));
    }

    return fragmentShader;
}

function createProgram(gl: WebGLRenderingContext, vertexShader: WebGLShader, fragmentShader: WebGLShader) {
    const program = gl.createProgram();
    if(program === null) {
        throw new Error("Error creating WebGL program.");
    }
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);

    // Check for linking errors
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        console.error("Program linking error:", gl.getProgramInfoLog(program));
    }

    return program;
}

function createFloat32Buffer(gl: WebGLRenderingContext, data: number[]) {
    const buffer = gl.createBuffer();
    if(buffer === null) {
        throw new Error("Error creating WebGL buffer.");
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array(data),
        gl.STATIC_DRAW
    );
    return buffer;
}