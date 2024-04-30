export function createVertexShader(gl: WebGLRenderingContext, vertexSource: string) {
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

export function createFragmentShader(gl: WebGLRenderingContext, fragmentSource: string) {
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

export function createProgram(gl: WebGLRenderingContext, vertexShader: WebGLShader, fragmentShader: WebGLShader) {
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

export function createFloat32Buffer(gl: WebGLRenderingContext, data: number[]) {
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