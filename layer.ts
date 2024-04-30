import mapboxgl, { CustomLayerInterface, MercatorCoordinate } from "mapbox-gl";
import { createFloat32Buffer, createFragmentShader, createProgram, createVertexShader } from "./gl_util";
import { getFragmentSource, getVertexSource } from "./shaders";

type RGBA = [number, number, number, number];

interface IChoroplethGridLayerOptions<T> {
    dataGrid: T[][],
    getColor: (d: T) => RGBA;
    stepSize: { lng: number, lat: number };
    offset: { lng: number, lat: number };
    opacity: number;
    layerId?: string;
}

function verifyOptions<T>({ dataGrid: dataArray, stepSize, offset, opacity }: IChoroplethGridLayerOptions<T>) {
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
    if(!dataArray.every(row => row !== undefined)) {
        throw new Error("A row in the data grid is undefined.");
    }
    if(opacity < 0 || opacity > 1) {
        throw new Error("Opacity must be greater than or equal to 0 and less than or equal to 1.");
    }
}

export function createLayer<T>(options: IChoroplethGridLayerOptions<T>): CustomLayerInterface {
    verifyOptions(options);

    // Get colors for each data point in the grid
    const colorGrid = options.dataGrid.map(row => row.map(p => {
        const color = options.getColor(p);
        if(!color.every(x => x >= 0 && x <= 255)) {
            throw new Error("Color values must be between 0 and 255.");
        }
        return color;
    }));

    // Find grid dimensions
    const gridSize = { x: colorGrid.length, y: 0 };
    if(colorGrid.length > 0) {
        gridSize.y = (colorGrid[0] as RGBA[]).length;
    }

    // Calculate bounds of dataset in world space
    const dataBounds = {
        sw: {
            lat: options.offset.lat,
            lng: options.offset.lng
        },
        ne: {
            lat: options.offset.lat + gridSize.y * options.stepSize.lat,
            lng: options.offset.lng + gridSize.x * options.stepSize.lng
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

    // Latitude doesn't scale linearly
    // Calculate Mercator space y-coordinates for each latitude step in the dataset
    const latStepsMercator: number[] = [];
    for(let lat = dataBounds.ne.lat; lat >= dataBounds.sw.lat; lat -= options.stepSize.lat) {
        const mercatorCoordinates = MercatorCoordinate.fromLngLat({ lng: 0, lat });
        latStepsMercator.push(mercatorCoordinates.y);
    }

    // Longitude scales linearly
    // Calculate a single step in Mercator space
    const lngStepMercator = (() => {
        const a = MercatorCoordinate.fromLngLat(dataBounds.sw);
        const b = MercatorCoordinate.fromLngLat({ lng: dataBounds.sw.lng + options.stepSize.lng, lat: dataBounds.sw.lat });
        return b.x - a.x;
    })();

    let g_map: mapboxgl.Map;
    let program: WebGLProgram;
    let bVertex: WebGLBuffer;
    let tGrid: WebGLTexture;

    return {
        id: options.layerId ?? "choropleth_grid",
        type: "custom",
        onAdd: function (map: mapboxgl.Map, gl: WebGLRenderingContext) {

            if(map.getProjection().name !== "mercator") {
                throw new Error("Choropleth grid layer is only supported for Mercator projection.");
            }

            g_map = map;

            const vertexShader = createVertexShader(gl, getVertexSource());
            const fragmentShader = createFragmentShader(gl, getFragmentSource(latStepsMercator.length, gridSize.x, gridSize.y));
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
            if(gridSize.x === 0) {
                return;
            }
            const colorGridFirstRow = colorGrid[0] as RGBA[];
            const transposed = colorGridFirstRow.map((_, i) => colorGrid.map(row => row[i]));
            transposed.reverse();
            const flat: number[] = [];
            transposed.map(row => {
                (row as RGBA[]).map(item => {
                    flat.push(...item);
                });
            });
            const gridData = new Uint8Array(flat);

            if(gridSize.x * gridSize.y * 4 !== gridData.length) {
                throw new Error(`Color matrix size (${gridSize.x * gridSize.y * 4}) does not match color matrix size (${gridData.length}) after transpose.`);
            }

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
        render: function (gl: WebGLRenderingContext, matrix: number[]) {

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